import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { SQL } from "bun"

import {
  readAttachment,
  storeAttachment,
} from "../../../../../../api/hono/src/lib/dashboard/attachments"
import { QUEUED_MS } from "../../../../../../api/hono/src/lib/dashboard/deliver"
import { standingFocus } from "../../../../../../api/hono/src/lib/dashboard/focus"
import {
  acceptArgs,
  ACTIONS,
  appsArgs,
  appsChange,
  answerInputSchema,
  answerLine,
  answerPayload,
  askCli,
  checkAnswer,
  closedPayload,
  inboxCount,
  inboxInputSchema,
  type Delivery,
  grantArgv,
  type InboxApps,
  type InboxItem,
  inboxOrder,
  isGo,
  proposalsOf,
  quietIds,
  runResult,
  savesDraft,
  secretInputSchema,
  type SecretSink,
  sinkArgv,
  slackPlace,
} from "../../../../../../api/hono/src/lib/dashboard/inbox"
import { uploadSpec } from "../../../../../../api/hono/src/lib/dashboard/slack-upload"
import { KEYCHAIN_ITEM_NAMES } from "../../../../../../api/hono/src/lib/keychain-items"
import { keychain } from "../../../../../../api/hono/src/lib/yard/keychain"
import {
  ANSWER_LEAD,
  CLOCKS_STOPPED_AT,
  payloadOf,
} from "../../../../../../packages/config/src/inbox"
import { RELAY_ANSWER_KINDS } from "../../../../../../packages/message/src/index"
import { writeFiles } from "../../../../../../packages/settings/src/folder"
import { GUARD_SETTING_KEYS } from "../../../../../../packages/settings/src/guard-keys"
import { judgeItem, putItem } from "../../../../../../packages/settings/src/items"
import { loginPath } from "../../../../../../packages/settings/src/rendered"
import {
  readSetting,
  resetSetting,
  setSetting,
  settingHistory,
  settingRows,
} from "../../../../../../packages/settings/src/settings-folder"
import { testContainerName } from "../../../../../container"

const CHANNEL = "https://app.slack.com/client/T0000000000/C0MADEUP01"
const SLACK = {
  link: CHANNEL,
  text: "hi Merritt, the fix is on staging.",
  to: "@Merritt",
  type: "slack",
}

const PREVIEWS = {
  ask: { text: "Port MADEDUNE-1401's fix to staging and main.", type: "ask" },
  budget: { amount: "$40", type: "budget", why: "A second account for a week" },
  delete: { type: "delete", what: "47 stale worktrees", why: "They hold 30 GB" },
  schema: { shape: "inbox_item(id text, ref integer)", type: "schema" },
  ship: {
    link: "https://github.com/acme/app/compare/main...3f9a2c1",
    prs: [{ number: 270, title: "Changelog entries read as text" }],
    sha: "3f9a2c1",
    type: "ship",
  },
  slack: SLACK,
  ticket: {
    body: "Totals differ after export.",
    noLink: "The team has no project for it yet",
    team: "AI Platform",
    title: "Export totals",
    type: "ticket",
  },
}

const decision = (preview: object) => ({ from: "ops", preview, title: "Ship canary to main?" })

const OPTIONS = [
  { description: "Staging first, a day of soak", label: "Port to staging, then main" },
  { label: "Hotfix main" },
  { label: "Wait for the next ship" },
]

describe("what bun run ask takes", () => {
  test("a decision for each kind of approval, a decision being the kind when none is named", () => {
    for (const [type, preview] of Object.entries(PREVIEWS)) {
      const parsed = inboxInputSchema.safeParse(decision(preview))
      expect(parsed.success, type).toBe(true)
      expect(parsed.data?.kind, type).toBe("decision")
    }
  })

  test("an ask may label what Approve and Deny do, one line each, beside its words (#790)", () => {
    const parsed = inboxInputSchema.safeParse(
      decision({
        ...PREVIEWS.ask,
        approve: "I port the fix to staging and main.",
        deny: "The port waits; nothing moves.",
      }),
    )
    expect(parsed.success).toBe(true)
    expect(parsed.data?.preview).toMatchObject({
      approve: "I port the fix to staging and main.",
      deny: "The port waits; nothing moves.",
    })
    // the labels are optional, so an old-shape ask still posts
    expect(inboxInputSchema.safeParse(decision(PREVIEWS.ask)).success).toBe(true)
    // each label is one short line
    expect(
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, approve: "two\nlines" })).success,
    ).toBe(false)
    expect(
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, deny: "x".repeat(201) })).success,
    ).toBe(false)
  })

  test("an ask offers 1 to 5 labelled options, and labels its go row in options or approve alone (#873)", () => {
    const ask = (over: object) => inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, ...over }))
    expect(ask({ options: OPTIONS }).success).toBe(true)
    expect(ask({ deny: "Leave it", options: [{ label: "Port it" }] }).success).toBe(true)
    const five = Array.from({ length: 5 }, (_, at) => ({ label: `Way ${at + 1}` }))
    expect(ask({ options: five }).success).toBe(true)
    // none, six or an unlabelled row is refused, naming the shape
    for (const options of [
      [],
      [...five, { label: "Way 6" }],
      [{ label: " " }],
      [{ description: "no label" }],
    ]) {
      const parsed = ask({ options })
      expect(parsed.success).toBe(false)
    }
    expect(JSON.stringify(ask({ options: [] }).error?.issues)).toContain(
      "An ask offers 1 to 5 options",
    )
    expect(ask({ approve: "Port it", options: OPTIONS }).error?.issues[0]?.message).toBe(
      "An ask labels its go row in options or in approve, not both",
    )
  })

  describe("an ask holds several questions, each with its own choices (#1250)", () => {
    const q = (n: number) =>
      Array.from({ length: n }, (_, at) => ({
        options: [{ label: "Yes" }, { label: "No" }],
        question: `Question ${at + 1}?`,
      }))
    const asksQ = (over: object) =>
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, ...over }))

    test("a questions list takes 2 to 20 entries and refuses 1 or 21", () => {
      expect(asksQ({ questions: q(2) }).success).toBe(true)
      expect(asksQ({ questions: q(20) }).success).toBe(true)
      expect(asksQ({ questions: q(1) }).success).toBe(false)
      expect(asksQ({ questions: q(21) }).success).toBe(false)
    })

    test("each entry has its own question and 1 to 5 options, recommended within them", () => {
      expect(
        asksQ({
          questions: [
            { options: [{ description: "soak a day", label: "staging" }], question: "Base?" },
            { options: [{ label: "now" }, { label: "later" }], question: "When?" },
          ],
        }).success,
      ).toBe(true)
      const six = Array.from({ length: 6 }, (_, at) => ({ label: `Way ${at + 1}` }))
      expect(asksQ({ questions: [{ options: six, question: "Q?" }, ...q(1)] }).success).toBe(false)
      expect(
        asksQ({
          questions: [
            { options: [{ label: "a" }, { label: "b" }], question: "Q?", recommended: 0 },
            { options: [{ label: "c" }], question: "R?" },
          ],
        }).success,
      ).toBe(true)
      expect(
        asksQ({
          questions: [
            { options: [{ label: "a" }, { label: "b" }], question: "Q?", recommended: 2 },
            ...q(1),
          ],
        }).success,
      ).toBe(false)
    })

    test("a questions list and top-level options, approve or deny are mutually exclusive", () => {
      expect(asksQ({ options: OPTIONS, questions: q(2) }).success).toBe(false)
      expect(asksQ({ approve: "Do it", questions: q(2) }).success).toBe(false)
      expect(asksQ({ deny: "Hold", questions: q(2) }).success).toBe(false)
    })

    test("an ask with no questions is unchanged", () => {
      expect(inboxInputSchema.safeParse(decision(PREVIEWS.ask)).success).toBe(true)
      expect(asksQ({ options: OPTIONS }).success).toBe(true)
    })
  })

  test("a draft is a recipient and the words, and an update an outcome with an optional link", () => {
    expect(
      inboxInputSchema.safeParse({
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
        title: "Ask Merritt to try the export fix",
      }).success,
    ).toBe(true)
    for (const outcome of ["alert", "decision", "finding", "merged", "shipped"]) {
      const parsed = inboxInputSchema.safeParse({
        from: "builder",
        kind: "update",
        preview: { link: "https://github.com/o/r/pull/270", outcome },
        title: "Merged: changelog entries read as text",
      })
      expect(parsed.success, outcome).toBe(true)
    }
  })

  test("an update may carry an approve page the owner opens in the browser, a web link alone", () => {
    const update = (approve: string) =>
      inboxInputSchema.safeParse({
        from: "Yard",
        kind: "update",
        preview: { approve, outcome: "decision", text: "a held post" },
        title: "Your steps post in #ops waits for your approval on Yard",
      }).success
    expect(update("https://yard.example/yard/approve/m1")).toBe(true)
    expect(update("javascript:alert(1)")).toBe(false)
  })

  test("a draft may link the thread it replies in, https alone", () => {
    const draft = (link: string) =>
      inboxInputSchema.safeParse({
        from: "dispatcher",
        kind: "draft",
        preview: { link, text: "on it", to: "Cameron's thread" },
        title: "Reply to Cameron",
      }).success
    expect(draft("https://linear.app/acme/issue/MADEDUNE-2186/x")).toBe(true)
    expect(
      draft(
        "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100",
      ),
    ).toBe(true)
    expect(draft("http://linear.app/acme/issue/MADEDUNE-2186")).toBe(false)
    expect(draft("https://acme.slack.com/archives/C0MADEUP01/p1700000000000100")).toBe(false)
  })

  test("a draft, or a slack, ship or ticket decision, names where it lands upfront, or why it cannot yet", () => {
    // the link leads, so the owner sees where a reply goes before reading the rest
    const draft = (preview: object) =>
      inboxInputSchema.safeParse({
        from: "dispatcher",
        kind: "draft",
        preview: { text: "hi", to: "@Merritt", ...preview },
        title: "Ask Merritt",
      }).success
    expect(draft({})).toBe(false)
    expect(draft({ link: CHANNEL })).toBe(true)
    expect(draft({ noLink: "A new DM nobody can open yet" })).toBe(true)
    expect(draft({ link: CHANNEL, noLink: "both" })).toBe(false)
    expect(draft({ link: "http://app.slack.com/client/T0000000000/C0MADEUP01" })).toBe(false)
    for (const type of ["slack", "ship", "ticket"] as const) {
      const { link: _link, noLink: _noLink, ...bare } = PREVIEWS[type] as Record<string, unknown>
      expect(inboxInputSchema.safeParse(decision(bare)).success, type).toBe(false)
      expect(
        inboxInputSchema.safeParse(decision({ ...bare, noLink: "None yet" })).success,
        type,
      ).toBe(true)
    }
    for (const type of ["ask", "budget", "delete", "schema"] as const) {
      expect(inboxInputSchema.safeParse(decision(PREVIEWS[type])).success, type).toBe(true)
    }
  })

  test("refuses a decision with no preview, or one of a kind Merritt does not approve", () => {
    expect(inboxInputSchema.safeParse({ from: "ops", title: "Go?" }).success).toBe(false)
    expect(inboxInputSchema.safeParse(decision({ type: "merge" })).success).toBe(false)
    // a plain ask is its words alone: none, an empty one or one with options is refused
    expect(inboxInputSchema.safeParse(decision({ type: "ask" })).success).toBe(false)
    expect(inboxInputSchema.safeParse(decision({ text: " ", type: "ask" })).success).toBe(false)
    expect(
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, options: ["Port", "Wait"] })).success,
    ).toBe(false)
    // the old ask's options are not a decision's preview
    expect(
      inboxInputSchema.safeParse({ ...decision(SLACK), options: [{ label: "Yes" }] }).success,
    ).toBe(false)
  })

  test("refuses an update that is progress rather than an outcome", () => {
    for (const outcome of ["progress", "eta", "started", undefined]) {
      expect(
        inboxInputSchema.safeParse({
          from: "worker-greed",
          kind: "update",
          preview: { outcome },
          title: "Round 2 started",
        }).success,
        String(outcome),
      ).toBe(false)
    }
  })

  test("takes an update that shows something read-only: an ask's text and files, no Approve (PG-2489)", () => {
    const shown = (preview: object) =>
      inboxInputSchema.safeParse({
        from: "builder",
        kind: "update",
        preview: { outcome: "finding", ...preview },
        title: "The table you asked for",
      }).success
    const file = {
      id: "0b7c4e2a-1f3d-4c5e-8a9b-2d6f7e8a9b0c.png",
      kind: "image",
      name: "table.png",
    }
    expect(shown({ attachments: [file], text: "| a | b |\n| - | - |\n| 1 | 2 |" })).toBe(true)
    expect(shown({ text: "" })).toBe(false)
    expect(shown({ attachments: [] })).toBe(false)
  })

  test("refuses a title over one line, a link that is not http, and an unknown key", () => {
    expect(inboxInputSchema.safeParse({ ...decision(SLACK), title: "a\nb" }).success).toBe(false)
    expect(
      inboxInputSchema.safeParse({
        from: "builder",
        kind: "update",
        preview: { link: "javascript:alert(1)", outcome: "merged" },
        title: "Merged",
      }).success,
    ).toBe(false)
    expect(inboxInputSchema.safeParse({ ...decision(SLACK), context: "x" }).success).toBe(false)
  })

  test("refuses an archives-style Slack link anywhere in an item, naming the converter", () => {
    const archives = "https://acme.slack.com/archives/C0MADEUP01/p1700000000000100"
    for (const input of [
      decision({ ...SLACK, text: `see ${archives}` }),
      { ...decision(SLACK), title: `Reply in ${archives}` },
      {
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text: archives, to: "@Merritt" },
        title: "Ask",
      },
      {
        from: "builder",
        kind: "update",
        preview: { link: archives, outcome: "finding" },
        title: "F",
      },
    ]) {
      const parsed = inboxInputSchema.safeParse(input)
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map((issue) => issue.message).join()).toContain(
        "never .../archives/...",
      )
    }
    const app =
      "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
    expect(inboxInputSchema.safeParse(decision({ ...SLACK, text: `see ${app}` })).success).toBe(
      true,
    )
  })

  test("refuses a raw Slack mention token anywhere in an item, naming readable names as the fix", () => {
    // a tag names who it reaches, never a bare handle the owner has to decode
    const draft = (text: string, to = "@Farley") => ({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text, to },
      title: "Ask Farley",
    })
    for (const token of [
      "<@U0EXAMPLE02>",
      "<@W0MADE0001|farley>",
      "<!subteam^S0A1HBY26MQ>",
      "<!subteam^S0A1HBY26MQ|@octo-avery>",
      "<!here>",
      "<!channel>",
      "<!everyone>",
      "<#C0MADEUP01>",
      "<#C0MADEUP01|peer-review-chat>",
    ]) {
      for (const input of [
        draft(`hey ${token}, can you help approve this?`),
        draft("hey", token),
        decision({ ...SLACK, text: `cc ${token}` }),
        { ...decision(SLACK), title: `Ask ${token}` },
      ]) {
        const parsed = inboxInputSchema.safeParse(input)
        expect(parsed.success, token).toBe(false)
        expect(parsed.error?.issues.map((issue) => issue.message).join(), token).toContain(
          "write mentions as readable names (@name, @team-name)",
        )
      }
    }
    for (const text of [
      "hey @Farley @octo-avery, can you help approve these? #peer-review-chat",
      `see ${CHANNEL} and https://github.com/o/r/pull/1`,
      "a <b>tag</b> and a <https://example.com|link>",
    ]) {
      expect(inboxInputSchema.safeParse(draft(text)).success, text).toBe(true)
    }
  })

  test("a draft, or a slack decision, speaks in the owner's voice: I, never we, and code or a quote is someone else's words (#674)", () => {
    // the owner speaks as I, me, my; never we, us, our, our side or the team
    const draft = (text: string) =>
      inboxInputSchema.safeParse({
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text, to: "@Merritt" },
        title: "Ask Merritt",
      })
    for (const [text, word] of [
      ["we will ship it", "we"],
      ["it reached us late", "us"],
      ["our side is done", "our"],
      ["the latest build is ours", "ours"],
      ["handled by ourselves alone", "ourselves"],
      ["We will ship it", "We"],
      ["OUR side is done", "OUR"],
      ["It is OURS", "OURS"],
      ["by OURSELVES alone", "OURSELVES"],
    ] as const) {
      const parsed = draft(`${text}.`)
      expect(parsed.success, text).toBe(false)
      expect(parsed.error?.issues.at(-1)?.message, text).toContain(`Found "${word}"`)
    }
    // the all-caps US is the country, not the pronoun, so it passes; the other words refuse in every case
    for (const fine of ["the US team grows", "US-east is up", "the US and the EU signed"]) {
      expect(draft(`${fine}.`).success, fine).toBe(true)
    }
    // a match a hyphen follows reads as a compound's half, a region name, not the pronoun (us-east-1)
    for (const fine of ["the region is us-east-1", "us-east-1 is up", "our-side is ready"]) {
      expect(draft(`${fine}.`).success, fine).toBe(true)
    }
    // a word inside a longer word is not the owner's voice
    for (const fine of ["trust the build", "two hours in", "as usual", "user asked"]) {
      expect(draft(`${fine}.`).success, fine).toBe(true)
    }
    // a link is an address, not a voice: bare, or Slack's <url|label>
    for (const fine of [
      "read https://acme.com/about-us first",
      "the deck lives at https://acme.com/us/en/ now",
      "<https://acme.com|our roadmap> has it",
    ]) {
      expect(draft(`${fine}.`).success, fine).toBe(true)
    }
    // code and quoted words are someone else's words
    expect(draft("run `we` twice.").success).toBe(true)
    expect(draft("```\nwe are the setup\n```").success).toBe(true)
    expect(draft('he said "we will look into it".').success).toBe(true)
    expect(draft("> we said so\nI will check.").success).toBe(true)
    // a slack decision's words are checked the same way
    expect(
      inboxInputSchema.safeParse(decision({ ...SLACK, text: "hi Merritt, we fixed it." })).success,
    ).toBe(false)
    // other kinds and previews are unaffected
    expect(
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, text: "we will port it now." }))
        .success,
    ).toBe(true)
    expect(
      inboxInputSchema.safeParse(
        decision({ ...PREVIEWS.delete, what: "our stale worktrees", why: "they hold 30 GB" }),
      ).success,
    ).toBe(true)
    expect(
      inboxInputSchema.safeParse({
        from: "builder",
        kind: "update",
        preview: { outcome: "alert" },
        title: "the Mac is on battery",
      }).success,
    ).toBe(true)
    // only the words are the owner's voice: a clean draft passes, its recipient's short name unchecked
    expect(
      inboxInputSchema.safeParse({
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text: "I will send it shortly.", to: "our thread" },
        title: "Ask Merritt",
      }).success,
    ).toBe(true)
  })

  test("a draft or a slack decision may carry its thread so far, one gist line a message, and no raw mention in it (#2287)", () => {
    const thread = [
      { said: "The export stops at 100 rows; we need all of them.", who: "Merritt" },
      { said: "Can it reach staging today?", who: "@Farley" },
    ]
    const draft = (preview: object) => ({
      from: "dispatcher",
      kind: "draft",
      preview: {
        link: CHANNEL,
        text: "hi Merritt, the fix is on staging.",
        to: "@Merritt",
        ...preview,
      },
      title: "Reply to Merritt",
    })
    // the other side's gist is their words, not the owner's voice, so their "we" passes
    for (const input of [draft({ thread }), decision({ ...SLACK, thread })]) {
      const parsed = inboxInputSchema.safeParse(input)
      expect(parsed.success).toBe(true)
      expect(parsed.data?.preview).toMatchObject({ thread })
    }
    // optional, so an item without one posts as before
    expect(inboxInputSchema.safeParse(draft({})).success).toBe(true)
    for (const bad of [
      [],
      Array.from({ length: 13 }, () => thread[0]),
      [{ said: "two\nlines", who: "Merritt" }],
      [{ said: "x".repeat(201), who: "Merritt" }],
      [{ said: "ok", who: "Merritt", ts: "1700000000.000100" }],
      [{ said: "ok" }],
    ]) {
      expect(inboxInputSchema.safeParse(draft({ thread: bad })).success, JSON.stringify(bad)).toBe(
        false,
      )
    }
    // an ask carries no thread
    expect(inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, thread })).success).toBe(false)
    for (const line of [
      { said: "cc <@U0EXAMPLE02>", who: "Merritt" },
      { said: "ok", who: "<@U0EXAMPLE02>" },
      { said: "<!here> look", who: "Merritt" },
    ]) {
      const parsed = inboxInputSchema.safeParse(draft({ thread: [line] }))
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map((issue) => issue.message).join()).toContain(
        "write mentions as readable names",
      )
    }
  })
})

describe("an ask to quit, restart, close or stop something (#1274)", () => {
  const QUIT = { text: "Quit cmux, then open it again.", type: "ask" }
  const CHECKED = "None: no ops job, process or session runs under cmux; /api/health reads ok"

  test("is refused until it names what was checked, and the refusal names the checks", () => {
    const parsed = inboxInputSchema.safeParse({ ...decision(QUIT), title: "Quit cmux?" })
    expect(parsed.success).toBe(false)
    const message = parsed.error?.issues.map((issue) => issue.message).join("\n") ?? ""
    for (const check of ["checked", "jobs.json", "processes", "sessions", "/api/health"]) {
      expect(message, check).toContain(check)
    }
  })

  test("posts once it carries checked, one line", () => {
    const parsed = inboxInputSchema.safeParse(decision({ ...QUIT, checked: CHECKED }))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.preview).toMatchObject({ checked: CHECKED })
    expect(inboxInputSchema.safeParse(decision({ ...QUIT, checked: "none\nreally" })).success).toBe(
      false,
    )
  })

  test("reads every verb, in its title and its labels too", () => {
    for (const text of ["Restart the dashboard.", "Close Docker.", "Stop OrbStack."]) {
      expect(inboxInputSchema.safeParse(decision({ text, type: "ask" })).success, text).toBe(false)
    }
    expect(
      inboxInputSchema.safeParse({ ...decision(PREVIEWS.ask), title: "Restart the Mac?" }).success,
    ).toBe(false)
    expect(
      inboxInputSchema.safeParse(decision({ ...PREVIEWS.ask, approve: "You quit cmux." })).success,
    ).toBe(false)
    expect(
      inboxInputSchema.safeParse(
        decision({
          approve: "Done",
          deny: "Can't stop OrbStack",
          text: "Free memory.",
          type: "ask",
        }),
      ).success,
    ).toBe(false)
  })

  test("reads any form of the four verbs that still asks", () => {
    for (const text of [
      "Approve once you have restarted cmux.",
      "Approve once you've closed Docker.",
      "Approve once you’ve closed Docker.",
      "Try restarting cmux, then approve.",
      "Approve after quitting cmux.",
      "You: stopped OrbStack yet? Approve once done.",
      "Once cmux is restarted, approve.",
      "Has cmux been restarted? Approve.",
      "Get cmux restarted, then approve.",
      "Restarting cmux clears it; approve when done.",
      "Approve when you're done restarting cmux.",
      "Approve once you had closed Docker.",
      "Port the fix after the dashboard restarted and then restart cmux.",
      "Get the dashboard restarted, then approve.",
      "Have the app closed, then approve.",
      "Approve once you have the dashboard stopped.",
      "Is the dashboard stopped yet? Approve when it is.",
      "Make the app quit, then approve.",
    ]) {
      expect(inboxInputSchema.safeParse(decision({ text, type: "ask" })).success, text).toBe(false)
    }
  })

  test("passes an ask that only mentions a restart in passing", () => {
    for (const text of [
      "Port the fix after the dashboard restarted.",
      "Port the fix since the app quit.",
      "Retry because the server stopped.",
    ]) {
      expect(inboxInputSchema.safeParse(decision({ text, type: "ask" })).success, text).toBe(true)
    }
  })
})

// an answer's time, as the store writes it
const AT = "2026-11-04T18:00:00.000Z"

const item = (over: Partial<InboxItem> & Pick<InboxItem, "kind">): InboxItem =>
  ({
    answer: null,
    createdAt: "2026-10-07T10:00:00.000Z",
    delivery: null,
    from: "ops",
    id: `id-${over.ref ?? 1}`,
    preview:
      over.kind === "update"
        ? { outcome: "merged" }
        : over.kind === "draft"
          ? { text: "hi", to: "@Merritt" }
          : SLACK,
    readAt: null,
    ref: 1,
    status: over.kind === "update" ? "done" : "open",
    title: "A title",
    updatedAt: "2026-10-07T10:00:00.000Z",
    version: 0,
    ...over,
  }) as InboxItem

describe("an answer", () => {
  test("approves, denies or edits a decision, and Edit needs the words", () => {
    const open = item({ kind: "decision" })
    expect(checkAnswer(open, { action: "approve" })).toEqual({
      answer: { choice: "approve" },
      status: "approved",
    })
    expect(checkAnswer(open, { action: "deny" })).toEqual({
      answer: { choice: "deny" },
      status: "denied",
    })
    expect(checkAnswer(open, { action: "edit", text: "Say tomorrow" })).toEqual({
      answer: { choice: "edit", editedText: "Say tomorrow" },
      status: "approved",
    })
    expect(checkAnswer(open, { action: "edit" })).toHaveProperty("message")
    expect(checkAnswer(open, { action: "send" })).toHaveProperty("message")
  })

  test("a lettered decision's go picks one of its options, and a yes or no takes none or its one (#873)", () => {
    const lettered = item({
      kind: "decision",
      preview: { ...PREVIEWS.ask, options: OPTIONS } as never,
    })
    expect(checkAnswer(lettered, { action: "approve", option: 2 })).toEqual({
      answer: { choice: "approve", option: 2 },
      status: "approved",
    })
    expect(checkAnswer(lettered, { action: "deny" })).toEqual({
      answer: { choice: "deny" },
      status: "denied",
    })
    for (const input of [
      { action: "approve" },
      { action: "approve", option: 3 },
      { action: "edit", text: "B, but tomorrow" },
    ] as const) {
      expect(checkAnswer(lettered, input)).toEqual({ message: "Pick one of its 3 options, 0 to 2" })
    }
    const open = item({ kind: "decision" })
    expect(checkAnswer(open, { action: "approve", option: 0 })).toEqual({
      answer: { choice: "approve", option: 0 },
      status: "approved",
    })
    expect(checkAnswer(open, { action: "approve", option: 1 })).toEqual({
      message: "A yes or no has one option, 0",
    })
    expect(checkAnswer(open, { action: "deny", option: 0 })).toEqual({
      message: "Only a decision's go picks an option",
    })
    expect(checkAnswer(item({ kind: "draft" }), { action: "send", option: 0 })).toEqual({
      message: "Only a decision's go picks an option",
    })
    expect(answerInputSchema.safeParse({ action: "approve", option: 5 }).success).toBe(false)
  })

  test("a multi-question ask approves with one pick per question, within its choices (#1250)", () => {
    const multi = item({
      kind: "decision",
      preview: {
        questions: [
          { options: [{ label: "staging" }, { label: "main" }], question: "Base?" },
          { options: [{ label: "now" }, { label: "later" }, { label: "soon" }], question: "When?" },
        ],
        text: "Pick for each.",
        type: "ask",
      } as never,
    })
    expect(checkAnswer(multi, { action: "approve", options: [0, 2] })).toEqual({
      answer: { choice: "approve", options: [0, 2] },
      status: "approved",
    })
    expect(checkAnswer(multi, { action: "deny" })).toEqual({
      answer: { choice: "deny" },
      status: "denied",
    })
    const invalid: Parameters<typeof checkAnswer>[1][] = [
      { action: "approve" },
      { action: "approve", option: 0 },
      { action: "approve", options: [0] },
      { action: "approve", options: [0, 1, 2] },
      { action: "approve", options: [0, 3] },
      { action: "approve", options: [2, 0] },
    ]
    for (const input of invalid) {
      expect(checkAnswer(multi, input)).toHaveProperty("message")
    }
    // a stray single option beside the per-question picks is refused, not silently ignored
    expect(checkAnswer(multi, { action: "approve", options: [0, 2], option: 0 })).toEqual({
      message: "A multi-question ask's approve names a pick for each question, not a single option",
    })
  })

  test("sends a draft as written or as changed, or discards it", () => {
    const draft = item({ kind: "draft" })
    expect(checkAnswer(draft, { action: "send", text: "hi" })).toEqual({
      answer: { choice: "send" },
      status: "sent",
    })
    expect(checkAnswer(draft, { action: "send", text: "hello" })).toEqual({
      answer: { choice: "send", editedText: "hello" },
      status: "sent",
    })
    expect(checkAnswer(draft, { action: "discard" })).toEqual({
      answer: { choice: "discard" },
      status: "discarded",
    })
    expect(checkAnswer(draft, { action: "approve" })).toHaveProperty("message")
  })

  test("saves a Slack draft as a draft in Slack, as written or as changed, and refuses it where the app has no draft API (#652)", () => {
    const slack = item({ kind: "draft" })
    expect(checkAnswer(slack, { action: "draft", text: "hi" })).toEqual({
      answer: { choice: "draft" },
      status: "drafted",
    })
    expect(checkAnswer(slack, { action: "draft", text: "hello" })).toEqual({
      answer: { choice: "draft", editedText: "hello" },
      status: "drafted",
    })
    expect(checkAnswer(slack, { action: "draft", text: "" })).toHaveProperty("message")
    const linear = item({
      kind: "draft",
      preview: { link: "https://linear.app/acme/issue/MADEDUNE-1/x", text: "hi", to: "MADEDUNE-1" },
    })
    expect(checkAnswer(linear, { action: "draft" })).toHaveProperty("message")
    expect(checkAnswer(linear, { action: "send" })).toEqual({
      answer: { choice: "send" },
      status: "sent",
    })
    expect(checkAnswer(item({ kind: "decision" }), { action: "draft" })).toHaveProperty("message")
    expect(savesDraft({ link: CHANNEL, text: "hi", to: "@Merritt" })).toBe(true)
    expect(savesDraft({ noLink: "a new DM", text: "hi", to: "@Merritt" })).toBe(true)
    expect(
      savesDraft({ link: "https://linear.app/acme/issue/MADEDUNE-1/x", text: "hi", to: "x" }),
    ).toBe(false)
    // a draft is a go: its poster closes it with the channel link the draft tool returns
    expect(isGo("draft")).toBe(true)
  })

  test("Clear sets a decision aside for later: a status of its own, neither a deny nor a discard, and never a go", () => {
    expect(checkAnswer(item({ kind: "decision" }), { action: "clear" })).toEqual({
      answer: { choice: "clear" },
      status: "cleared",
    })
    expect(isGo("clear")).toBe(false)
    // a draft is archived as a decision is, its own Discard still saying no (PG-654)
    expect(checkAnswer(item({ kind: "draft" }), { action: "clear" })).toEqual({
      answer: { choice: "clear" },
      status: "cleared",
    })
    expect(checkAnswer(item({ kind: "update" }), { action: "clear" })).toHaveProperty("message")
  })

  test("his note goes with every answer, and stays off a refused one", () => {
    for (const [kind, action] of [
      ["decision", "approve"],
      ["decision", "clear"],
      ["decision", "deny"],
      ["draft", "discard"],
      ["draft", "draft"],
      ["draft", "send"],
    ] as const) {
      expect(checkAnswer(item({ kind }), { action, note: " after the demo " })).toMatchObject({
        answer: { choice: action, note: "after the demo" },
      })
    }
    expect(
      checkAnswer(item({ kind: "decision" }), { action: "edit", note: "x", text: "Wait" }),
    ).toMatchObject({ answer: { editedText: "Wait", note: "x" }, status: "approved" })
    // an empty note adds nothing
    expect(checkAnswer(item({ kind: "decision" }), { action: "approve", note: "  " })).toEqual({
      answer: { choice: "approve" },
      status: "approved",
    })
    expect(checkAnswer(item({ kind: "update" }), { action: "approve", note: "x" })).toEqual({
      message: "An update is read, not answered",
    })
    expect(answerInputSchema.safeParse({ action: "approve", note: "x".repeat(4000) }).success).toBe(
      true,
    )
    expect(answerInputSchema.safeParse({ action: "approve", note: "x".repeat(4001) }).success).toBe(
      false,
    )
  })

  test("leaves an update and an answered item alone", () => {
    expect(checkAnswer(item({ kind: "update" }), { action: "approve" })).toHaveProperty("message")
    expect(
      checkAnswer(item({ kind: "decision", status: "approved" }), { action: "deny" }),
    ).toHaveProperty("message")
  })

  test("names slack.linkConverter and slack.sendServer once the extensions' policy sets them", async () => {
    const data = mkdtempSync(join(tmpdir(), "inbox-slack-"))
    await Bun.write(
      join(data, "extensions", "policy.json"),
      JSON.stringify({
        values: { "slack.linkConverter": "made-up-convert", "slack.sendServer": "made-up-slack" },
      }),
    )
    const was = process.env.PLAYGROUND_DATA_DIR
    process.env.PLAYGROUND_DATA_DIR = data
    try {
      expect(
        answerPayload(item({ kind: "draft" }), { at: AT, choice: "draft" }).linkConverter,
      ).toBe("made-up-convert")
      const parsed = inboxInputSchema.safeParse({
        from: "builder",
        kind: "update",
        preview: { link: "https://acme.slack.com/archives/C1/p1", outcome: "finding" },
        title: "F",
      })
      expect(parsed.error?.issues.map((issue) => issue.message).join()).toContain(
        "never .../archives/...; rewrite it with made-up-convert",
      )
    } finally {
      if (was === undefined) delete process.env.PLAYGROUND_DATA_DIR
      else process.env.PLAYGROUND_DATA_DIR = was
      rmSync(data, { force: true, recursive: true })
    }
  })

  // every click that reaches a poster types one line of data, which answerPayloadSchema parses, never prose
  test("every answer click types one [inbox-answer] line that answerPayloadSchema parses", () => {
    const decided = item({
      id: "abc",
      kind: "decision",
      ref: 41,
      title: "Ship canary 3f9a2c1 to main?",
    })
    const drafted = item({ id: "def", kind: "draft", ref: 42, title: "Tell Merritt" })
    const secret = item({
      id: "ghi",
      kind: "decision",
      preview: {
        key: "API_KEY",
        sink: { item: KEYCHAIN_ITEM_NAMES[0], type: "keychain" },
        type: "secret",
      } as never,
      ref: 43,
      title: "The API key",
    })
    const accepting = item({
      id: "jkl",
      kind: "decision",
      preview: ACCEPT as never,
      ref: 44,
      title: "Accept",
    })
    const read = (ref: number) => `playground ask get #i${ref} --ack`
    const ack = (ref: number) => `playground ask ack #i${ref} --link <https url>`
    const ackOrWhy = (ref: number) => `${ack(ref)}, or --no-link "<why>" when it leaves no page`
    const asked = item({
      id: "mno",
      kind: "decision",
      preview: PREVIEWS.ask as never,
      ref: 45,
      title: "Port it?",
    })
    const labelled = item({
      id: "pqr",
      kind: "decision",
      preview: {
        ...PREVIEWS.ask,
        approve: "Port the fix to staging, then main",
        deny: "Keep it on main",
      } as never,
      ref: 46,
      title: "Port it?",
    })
    const lettered = item({
      id: "stu",
      kind: "decision",
      preview: { ...PREVIEWS.ask, options: OPTIONS } as never,
      ref: 47,
      title: "Which way?",
    })
    const several = item({
      id: "vwx",
      kind: "decision",
      preview: {
        ...PREVIEWS.ask,
        questions: [
          { options: [{ label: "staging" }, { label: "main" }], question: "Base?" },
          { options: [{ label: "now" }, { label: "later" }, { label: "soon" }], question: "When?" },
        ],
      } as never,
      ref: 48,
      title: "Pick for each?",
    })
    const cases: [InboxItem, Parameters<typeof answerPayload>[1], Record<string, unknown>][] = [
      [
        decided,
        { at: AT, choice: "approve" },
        {
          close: ack(41),
          go: true,
          next: "carry-out",
          option: { index: 0, label: "Send it to @Merritt", letter: "A" },
          type: "slack",
          verb: "pick",
        },
      ],
      // a go whose preview names no link may leave no page, so its close names --no-link too
      [
        asked,
        { at: AT, choice: "approve" },
        { close: ackOrWhy(45), next: "carry-out", type: "ask" },
      ],
      // a pick of an ask carrying its own labels names the label its card showed
      [
        labelled,
        { at: AT, choice: "approve" },
        {
          option: { index: 0, label: "Port the fix to staging, then main", letter: "A" },
          verb: "pick",
        },
      ],
      [
        labelled,
        { at: AT, choice: "deny" },
        { option: { index: 1, label: "Keep it on main", letter: "B" }, verb: "pick" },
      ],
      // a lettered ask's pick names the go row its option points at, and its deny the None of these after the last
      [
        lettered,
        { at: AT, choice: "approve", option: 1 },
        { go: true, option: { index: 1, label: "Hotfix main", letter: "B" }, verb: "pick" },
      ],
      [
        lettered,
        { at: AT, choice: "deny" },
        { go: false, option: { index: 3, label: "None of these", letter: "D" }, verb: "pick" },
      ],
      // a multi-question ask's approve names one pick per question, each by its letter and label, and reads its note back
      [
        several,
        { at: AT, choice: "approve", note: "both fine", options: [0, 2] },
        {
          comment: "both fine",
          go: true,
          next: "carry-out",
          picks: [
            { index: 0, label: "staging", letter: "A", question: "Base?" },
            { index: 2, label: "soon", letter: "C", question: "When?" },
          ],
          type: "ask",
          verb: "pick",
        },
      ],
      [
        decided,
        { at: AT, choice: "edit", editedText: "Wait for #299" },
        { go: true, next: "carry-out", text: "Wait for #299", verb: "pick" },
      ],
      [
        decided,
        { at: AT, choice: "deny", note: "ask again next week" },
        {
          close: read(41),
          comment: "ask again next week",
          go: false,
          next: "close",
          option: { index: 1, label: "Do not send it", letter: "B" },
          verb: "pick",
        },
      ],
      [
        decided,
        { at: AT, choice: "clear" },
        { close: read(41), go: false, next: "close", verb: "set-aside" },
      ],
      [
        drafted,
        { at: AT, choice: "send" },
        { close: ack(42), go: true, kind: "draft", next: "carry-out", verb: "send" },
      ],
      [drafted, { at: AT, choice: "send", editedText: "hey" }, { text: "hey", verb: "send" }],
      [
        drafted,
        { at: AT, choice: "draft" },
        { close: ackOrWhy(42), go: true, next: "carry-out", verb: "draft" },
      ],
      [
        drafted,
        { at: AT, choice: "discard" },
        { close: read(42), go: false, next: "close", verb: "discard" },
      ],
      [
        secret,
        {
          at: AT,
          choice: "provided",
          results: [{ environment: "keychain", exitCode: 0, line: "saved" }],
        },
        {
          close: read(43),
          go: true,
          next: "close",
          results: [{ environment: "keychain", exitCode: 0, line: "saved" }],
          verb: "submit",
        },
      ],
      [
        accepting,
        { accepted: { exitCode: 0, line: "rev 9b8c7d6 is accepted" }, at: AT, choice: "approve" },
        {
          accepted: { exitCode: 0, line: "rev 9b8c7d6 is accepted" },
          close: 'playground ask ack #i44 --no-link "<why>"',
          next: "nothing",
          verb: "pick",
        },
      ],
    ]
    for (const [it, answer, expected] of cases) {
      const line = answerLine(answerPayload(it, answer))
      expect(line).toStartWith(`${ANSWER_LEAD} {`)
      expect(line).not.toContain("\n")
      // answerLine has parsed the payload strictly, so payloadOf reading it back is the schema check
      const payload = payloadOf(line)
      expect(payload).not.toBeNull()
      // only a pick names an option
      if (payload?.verb !== "pick") expect(payload).not.toHaveProperty("option")
      expect(payload).toMatchObject({
        at: AT,
        id: it.id,
        ref: `#i${it.ref}`,
        title: it.title,
        v: 1,
        ...expected,
      })
    }
    // a comment's line ends stay inside the one line, escaped by JSON
    const noted = answerLine(answerPayload(decided, { at: AT, choice: "deny", note: "one\ntwo" }))
    expect(noted.split("\n")).toHaveLength(1)
    expect(payloadOf(noted)?.comment).toBe("one\ntwo")
    // no comment, no key
    expect(answerPayload(decided, { at: AT, choice: "deny" })).not.toHaveProperty("comment")
    // a live-reads test stack's close names its own checkout's CLI, so a probe never closes the live Inbox's item of that number
    const own = "bun run --cwd /wt ask"
    expect(answerPayload(decided, { at: AT, choice: "deny" }, own).close).toBe(
      `${own} get #i${decided.ref} --ack`,
    )
    const denied = { ...decided, answer: { at: AT, choice: "deny" } } as InboxItem
    expect(closedPayload(denied, "dismiss", AT, own).close).toBe(
      `${own} get #i${decided.ref} --ack`,
    )
  })

  test("a close names playground ask, but a live-reads test stack's own checkout's CLI", () => {
    expect(askCli({ kind: "live", rule: "live-branch" }, "/live")).toBe("playground ask")
    expect(askCli({ kind: "live", rule: "own" }, "/mine")).toBe("playground ask")
    expect(askCli({ file: null, kind: "fixture", rule: "factory" }, "/wt")).toBe("playground ask")
    expect(askCli({ kind: "live", rule: "live-reads" }, "/wt")).toBe("bun run --cwd /wt ask")
    expect(askCli({ kind: "live", rule: "live-reads" }, null)).toBe("playground ask")
  })

  // Send types the words alone into the poster: a draft's files are shared into Slack by the dashboard itself (PG-649), never handed to the session
  test("sends a draft's words alone, its pictures left on the card (PG-501)", () => {
    const words = { text: "the fix is live", to: "@Merritt" }
    const plain = item({ kind: "draft", preview: words })
    const shown = item({
      kind: "draft",
      preview: {
        ...words,
        attachments: [
          { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png", kind: "image", name: "before.png" },
        ],
      },
    })
    for (const answer of [
      { choice: "send" },
      { choice: "send", editedText: "hey" },
      { choice: "draft" },
    ] as const) {
      const line = answerLine(answerPayload(shown, { ...answer, at: AT }))
      expect(line).toBe(answerLine(answerPayload(plain, { ...answer, at: AT })))
      expect(line).not.toContain("before.png")
      expect(line).not.toContain("3f0e7a52-1c4b-4d2a-9e6f-0000000000a1")
    }
  })
})

describe("the list", () => {
  // the owner gets the Mac for a stretch: what comes in waits quiet, but an alert cannot wait (#974)
  test("while focus stands, what came in since it began is quiet, an alert update aside, and nothing is with no focus", () => {
    const since = "2026-10-07T10:00:00.000Z"
    const items = [
      item({ createdAt: "2026-10-07T09:59:59.000Z", kind: "decision", ref: 1 }),
      item({ createdAt: since, kind: "decision", ref: 2 }),
      item({ createdAt: "2026-10-07T10:05:00.000Z", kind: "update", ref: 3 }),
      item({
        createdAt: "2026-10-07T10:06:00.000Z",
        kind: "update",
        preview: { outcome: "alert" },
        ref: 4,
      }),
    ]
    expect(quietIds(items, { since })).toEqual(["id-2", "id-3"])
    expect(quietIds(items, null)).toEqual([])
  })

  test("puts what needs him first, then unread updates, then the rest, each newest first (#i545)", () => {
    const items = [
      item({ kind: "update", readAt: "2026-10-07T11:00:00.000Z", ref: 1 }),
      item({ kind: "decision", ref: 2 }),
      item({ kind: "update", ref: 3 }),
      item({ kind: "draft", ref: 4 }),
      item({ kind: "update", ref: 5 }),
      item({ kind: "decision", ref: 6, status: "approved" }),
    ]
    expect(inboxOrder(items).map((i) => i.ref)).toEqual([4, 2, 5, 3, 6, 1])
    expect(inboxCount(items)).toBe(4)
  })

  test("an answer that failed to send needs him, newest first among what does, until he dismisses it", () => {
    const failed = {
      code: "SESSIONS_FAILED",
      reason: "no answer from cmux",
      status: "failed",
    } as const
    const answer = { at: "2026-10-07T11:00:00.000Z", choice: "send" } as const
    const items = [
      item({ kind: "update", ref: 3 }),
      item({ kind: "decision", ref: 5 }),
      item({ answer, delivery: failed, kind: "draft", ref: 4, status: "sent" }),
      item({
        answer: { ...answer, dismissedAt: "2026-10-07T12:00:00.000Z" },
        delivery: failed,
        kind: "draft",
        ref: 2,
        status: "sent",
      }),
    ]
    expect(inboxOrder(items).map((i) => i.ref)).toEqual([5, 4, 3, 2])
    expect(inboxCount(items)).toBe(3)
  })

  test("an item he replied to in chat leaves the count and what needs him, but stays in the list until its poster closes it", () => {
    const items = [
      item({ kind: "decision", ref: 2 }),
      item({
        answer: { at: "2026-10-07T11:00:00.000Z", choice: "replied" },
        kind: "decision",
        ref: 7,
      }),
      item({ kind: "update", ref: 3 }),
    ]
    expect(inboxCount(items)).toBe(2)
    expect(inboxOrder(items).map((i) => i.ref)).toEqual([2, 3, 7])
  })

  test("a scheduled item is out of the count and what needs him until its time passes, then back (Schedule)", () => {
    const snoozed = {
      answer: { snoozedUntil: "2026-10-07T12:00:00.000Z" },
      kind: "decision",
      ref: 2,
    } as const
    const items = [
      item(snoozed),
      item({ kind: "decision", ref: 3 }),
      item({ kind: "decision", ref: 4 }),
    ]
    const before = new Date("2026-10-07T11:00:00.000Z")
    expect(inboxCount(items, before)).toBe(2)
    // asleep it leaves what needs him; awake it asks again, newest first
    expect(inboxOrder(items, before).map((i) => i.ref)).toEqual([4, 3, 2])
    const after = new Date("2026-10-07T12:00:00.000Z")
    expect(inboxCount(items, after)).toBe(3)
    expect(inboxOrder(items, after).map((i) => i.ref)).toEqual([4, 3, 2])
  })
})

const SECRET = {
  key: "GITHUB_CLIENT_SECRET",
  sink: {
    environments: ["production", "preview"],
    project: "api-made-up",
    scope: "made-up-team",
    type: "vercel",
  },
  type: "secret",
}

describe("a secret ask (PG-59)", () => {
  test("names its key and a sink from the allowlist, with each environment once", () => {
    expect(inboxInputSchema.safeParse(decision(SECRET)).success).toBe(true)
    const refused = (sink: object, key = SECRET.key) =>
      inboxInputSchema.safeParse(decision({ ...SECRET, key, sink: { ...SECRET.sink, ...sink } }))
        .success
    // a sink outside the allowlist in code
    expect(refused({ type: "netlify" })).toBe(false)
    expect(refused({ command: "sh -c 'cat > /tmp/x'" })).toBe(false)
    // a name that would read as a flag, or holds a space, never reaches argv
    expect(refused({ project: "--token=x" })).toBe(false)
    expect(refused({ scope: "made up" })).toBe(false)
    expect(refused({ environments: [] })).toBe(false)
    expect(refused({ environments: ["production", "production"] })).toBe(false)
    expect(refused({ environments: ["staging"] })).toBe(false)
    expect(refused({}, "NOT A KEY")).toBe(false)
    expect(refused({}, "-e")).toBe(false)
  })

  test("takes a keychain sink naming an allowlisted item, slack or yard, and no other sink", () => {
    const sinkOf = (sink: object) =>
      inboxInputSchema.safeParse(decision({ ...SECRET, key: "YARD_TOKEN", sink })).success
    expect(sinkOf({ item: "yard", type: "keychain" })).toBe(true)
    expect(sinkOf({ item: "slack", type: "keychain" })).toBe(true)
    expect(sinkOf({ item: "vault", type: "keychain" })).toBe(false)
    expect(sinkOf({ item: "../x", type: "keychain" })).toBe(false)
    expect(sinkOf({ type: "keychain" })).toBe(false)
    expect(sinkOf({ item: "yard", project: "api-made-up", type: "keychain" })).toBe(false)
    expect(sinkOf({ item: "yard", type: "yard" })).toBe(false)
    expect(sinkOf({})).toBe(false)
  })

  test("runs one vercel env add an environment, the value never in its argv", () => {
    const sink = SECRET.sink as Extract<SecretSink, { type: "vercel" }>
    expect(sinkArgv(SECRET.key, sink, "preview")).toEqual([
      "vercel",
      "env",
      "add",
      "GITHUB_CLIENT_SECRET",
      "--environment",
      "preview",
      "--project",
      "api-made-up",
      "--scope",
      "made-up-team",
      "--yes",
    ])
  })

  test("takes no Approve, Deny or Edit as an answer: its value comes through Submit alone, Dismiss setting it aside", () => {
    const open = { kind: "decision", preview: SECRET, status: "open" } as const
    expect(checkAnswer(open as never, { action: "dismiss" })).toMatchObject({ status: "cleared" })
    for (const action of ACTIONS.filter((action) => action !== "dismiss")) {
      expect(checkAnswer(open as never, { action, text: "made-up-value" }), action).toHaveProperty(
        "message",
      )
    }
  })

  test("the value is text, trimmed, and never empty", () => {
    expect(secretInputSchema.safeParse({ value: "  made-up  " }).data?.value).toBe("made-up")
    expect(secretInputSchema.safeParse({ value: "   " }).success).toBe(false)
    expect(secretInputSchema.safeParse({}).success).toBe(false)
    expect(secretInputSchema.safeParse({ extra: 1, value: "made-up" }).success).toBe(false)
  })
})

const ACCEPT = {
  key: "end-of-day",
  kind: "skill",
  rev: "3f9a2c1d",
  scope: "acme",
  type: "accept",
  why: "Scored 4 by two reviewers; it reads the day's merges",
}

// two more made-up proposals a list accepts after ACCEPT, in this order
const MORE_B = { key: "handover", kind: "doc", rev: "4a0b1c2d", scope: "acme" }
const MORE_C = { key: "quiet-hours", kind: "rule", rev: "5b1c2d3e", scope: "acme" }

const APPS = { app: "Notes", change: "add", type: "apps", why: "It holds your own notes" }

const GRANT = {
  permission: "screen-recording",
  type: "grant",
  why: "The release check takes a screenshot of the simulator",
}

describe("an accept decision (PG-658)", () => {
  test("names a scope, kind, key and rev the store takes, none of which can start as a flag", () => {
    expect(inboxInputSchema.safeParse(decision(ACCEPT)).success).toBe(true)
    const takes = (change: object) =>
      inboxInputSchema.safeParse(decision({ ...ACCEPT, ...change })).success
    for (const change of [
      { scope: "--yes" },
      { scope: "-acme" },
      { scope: "acme/../core" },
      { key: "--reason" },
      { key: "End-Of-Day" },
      { key: "a b" },
      { kind: "hook" },
      { rev: "--all" },
      { rev: "HEAD" },
      { rev: "3f9a2c" },
      { why: "" },
      { extra: "--yes" },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  test("takes more proposals after the first, in the order they land, each by the first one's rules, at most 20 (PG-1149)", () => {
    const more = (list: object[]) =>
      inboxInputSchema.safeParse(decision({ ...ACCEPT, more: list })).success
    expect(more([MORE_B, MORE_C])).toBe(true)
    expect(more([])).toBe(false)
    expect(more(Array.from({ length: 21 }, () => MORE_B))).toBe(false)
    for (const change of [
      { scope: "--yes" },
      { key: "--reason" },
      { rev: "HEAD" },
      { kind: "hook" },
      { why: "x" },
    ])
      expect(more([{ ...MORE_B, ...change }]), JSON.stringify(change)).toBe(false)
    const parsed = inboxInputSchema.parse(decision({ ...ACCEPT, more: [MORE_B, MORE_C] }))
    if (parsed.kind !== "decision" || parsed.preview.type !== "accept") throw new Error("no accept")
    expect(proposalsOf(parsed.preview).map((p) => `${p.kind} ${p.key}`)).toEqual([
      "skill end-of-day",
      "doc handover",
      "rule quiet-hours",
    ])
    expect(proposalsOf(inboxInputSchema.parse(decision(ACCEPT)).preview as never)).toEqual([
      { key: "end-of-day", kind: "skill", rev: "3f9a2c1d", scope: "acme" },
    ])
  })

  test("its Approve runs one fixed argv: the preview's words and a reason naming the item", () => {
    const parsed = inboxInputSchema.parse(decision(ACCEPT))
    if (parsed.kind !== "decision" || parsed.preview.type !== "accept") throw new Error("no accept")
    expect(acceptArgs(parsed.preview, 41)).toEqual([
      "accept",
      "acme",
      "skill",
      "end-of-day",
      "3f9a2c1d",
      "--reason",
      "the owner approved it in the Inbox (#i41)",
    ])
  })

  test("is approved, denied or cleared as it reads, never edited", () => {
    const open = { kind: "decision", preview: ACCEPT, status: "open" } as never
    expect(checkAnswer(open, { action: "approve" })).toMatchObject({ status: "approved" })
    expect(checkAnswer(open, { action: "deny" })).toMatchObject({ status: "denied" })
    expect(checkAnswer(open, { action: "edit", text: "accept core's too" })).toHaveProperty(
      "message",
    )
  })

  test("its result is the exit code and one line: the CLI's line, else its error, cut to a line", () => {
    expect(runResult({ code: 0, err: "", out: "rev 9b8c7d6 is accepted\n" })).toEqual({
      exitCode: 0,
      line: "rev 9b8c7d6 is accepted",
    })
    expect(
      runResult({ code: 1, err: "409 the proposal is at 0a1b2c3, not 3f9a2c1d\nmore", out: "" }),
    ).toEqual({ exitCode: 1, line: "409 the proposal is at 0a1b2c3, not 3f9a2c1d" })
    expect(runResult({ code: 1, err: "x".repeat(500), out: "" }).line).toHaveLength(200)
  })
})

describe("a grant decision (PG-658)", () => {
  test("names one of agent-desktop's two permissions, and nothing else", () => {
    expect(inboxInputSchema.safeParse(decision(GRANT)).success).toBe(true)
    expect(
      inboxInputSchema.safeParse(decision({ ...GRANT, permission: "accessibility" })).success,
    ).toBe(true)
    const takes = (change: object) =>
      inboxInputSchema.safeParse(decision({ ...GRANT, ...change })).success
    for (const change of [
      { permission: "automation" },
      { permission: "--reveal" },
      { why: "" },
      { extra: "x" },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  test("its Approve runs one fixed argv: macOS's open at the permission's own pane", () => {
    const parsed = inboxInputSchema.parse(decision(GRANT))
    if (parsed.kind !== "decision" || parsed.preview.type !== "grant") throw new Error("no grant")
    expect(grantArgv(parsed.preview)).toEqual([
      "/usr/bin/open",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ])
    expect(grantArgv({ ...parsed.preview, permission: "accessibility" })).toEqual([
      "/usr/bin/open",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ])
  })

  test("is approved, denied or cleared as it reads, never edited", () => {
    const open = { kind: "decision", preview: GRANT, status: "open" } as never
    expect(checkAnswer(open, { action: "approve" })).toMatchObject({ status: "approved" })
    expect(checkAnswer(open, { action: "edit", text: "accessibility too" })).toHaveProperty(
      "message",
    )
  })
})

describe("an apps decision (PG-658)", () => {
  const apps = (change: Partial<InboxApps> = {}) => ({ ...APPS, ...change }) as InboxApps

  test("names an app to add or remove, which can start as no flag and name no path", () => {
    expect(inboxInputSchema.safeParse(decision(APPS)).success).toBe(true)
    expect(
      inboxInputSchema.safeParse(decision({ ...APPS, app: "Google Chrome", change: "remove" }))
        .success,
    ).toBe(true)
    const takes = (change: object) =>
      inboxInputSchema.safeParse(decision({ ...APPS, ...change })).success
    expect(takes({ app: "Téléphone" })).toBe(true)
    for (const change of [
      { app: "--headed" },
      { app: "-Notes" },
      { app: "/Applications/Notes.app" },
      { app: "../Notes" },
      { app: "" },
      { change: "replace" },
      { why: "" },
      { extra: "x" },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  test("its Approve runs one fixed argv: a put of the login's own list from stdin, with a reason naming the item", () => {
    expect(appsArgs("owner", 41)).toEqual([
      "put",
      "owner",
      "list",
      "desktop-owner-apps",
      "-",
      "--reason",
      "the owner approved it in the Inbox (#i41)",
    ])
  })

  test("adds or removes the app, matched as the hook matches it, or says why nothing is written", () => {
    expect(appsChange(["Slack"], apps())).toEqual({ list: ["Slack", "Notes"] })
    expect(appsChange(["notes.app"], apps())).toEqual({
      exitCode: 0,
      line: "Notes is on your apps already",
    })
    expect(appsChange(["Slack", "NOTES"], apps({ change: "remove" }))).toEqual({ list: ["Slack"] })
    expect(appsChange(["Slack"], apps({ change: "remove" }))).toEqual({
      exitCode: 1,
      line: "Notes is not on your own apps list, so nothing changed",
    })
    for (const entry of ["/Applications/Notes.app", " Notes", "Notes.APP"]) {
      expect(appsChange(["Slack", entry], apps())).toEqual({
        exitCode: 0,
        line: "Notes is on your apps already",
      })
      expect(appsChange(["Slack", entry], apps({ change: "remove" }))).toEqual({ list: ["Slack"] })
    }
  })

  test("is approved, denied or cleared as it reads, never edited", () => {
    const open = { kind: "decision", preview: APPS, status: "open" } as never
    expect(checkAnswer(open, { action: "deny" })).toMatchObject({ status: "denied" })
    expect(checkAnswer(open, { action: "edit", text: "Slack instead" })).toHaveProperty("message")
  })
})

// A made-up org's Slack gate: no real org, channel or server is named in a test.
const GATE = { path: "/made/up/send", selfDm: "D0MADEUP1", servers: ["made-up-slack"] }
const GUARD = {
  key: "slack.gatedSends",
  scope: "acme-test",
  type: "guard",
  value: GATE,
  why: "Back the org's no-Slack-writes guard",
}

describe("a guard decision (PG-1090)", () => {
  const takes = (change: object) =>
    inboxInputSchema.safeParse(decision({ ...GUARD, ...change })).success

  test("carries a key a guard reads, its scope and a value its key's schema takes, or no value", () => {
    expect(takes({})).toBe(true)
    expect(takes({ scope: "made-up-me" })).toBe(true)
    expect(takes({ value: undefined })).toBe(true)
    expect(takes({ value: "" })).toBe(true)
    for (const key of GUARD_SETTING_KEYS) expect(takes({ key, value: undefined }), key).toBe(true)
  })

  test("refuses any key off GUARD_SETTING_KEYS, core as its scope, and a value its key refuses", () => {
    for (const change of [
      { key: "slack.mode" },
      { key: "made.up" },
      { scope: "core" },
      { scope: "-acme" },
      { scope: "acme/test" },
      { value: { ...GATE, selfDm: "C0MADEUP1" } },
      { value: { path: "/made/up/send" } },
      { value: 7 },
      { why: "" },
      { extra: "x" },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  test("is approved, denied or cleared as it reads, never edited, and stays off the relay", () => {
    const open = { kind: "decision", preview: GUARD, status: "open" } as never
    expect(checkAnswer(open, { action: "deny" })).toMatchObject({ status: "denied" })
    expect(checkAnswer(open, { action: "edit", text: "another value" })).toHaveProperty("message")
    expect(RELAY_ANSWER_KINDS as readonly string[]).not.toContain("guard")
  })
})

// PG-1196: the guard decision also sets a job's enabled field, which no session may write either.
describe("a guard decision for a job (PG-1196)", () => {
  const takes = (change: object) =>
    inboxInputSchema.safeParse(decision({ ...GUARD, ...change })).success

  test("takes a registry job's enabled field alone, or no value", () => {
    expect(takes({ key: "jobs.opsZaiUsage", value: { enabled: true } })).toBe(true)
    expect(takes({ key: "jobs.opsSweep", value: { enabled: false } })).toBe(true)
    expect(takes({ key: "jobs.opsZaiUsage", value: undefined })).toBe(true)
  })

  // #1336: a job the registry does not name is an org's own job, whose enabled field alone is a part Approve writes over the org's row, so only a value that is neither a part nor a whole row is refused
  test("refuses a job decision carrying any field but enabled, and a job the registry does not name with neither a part nor a whole row", () => {
    for (const change of [
      { key: "jobs.opsZaiUsage", value: { command: "made-up", enabled: true } },
      { key: "jobs.opsZaiUsage", value: { enabled: true, schedule: { every: 5 } } },
      { key: "jobs.opsZaiUsage", value: {} },
      { key: "jobs.opsZaiUsage", value: true },
      { key: "jobs.opsMadeUp", value: { enabled: true, schedule: { every: 5 } } },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  // #1336: a session proposes a job's config as a new object, which core checks only for being an object
  test("takes a registry job's config alone, as an object of any fields (#1336)", () => {
    expect(takes({ key: "jobs.opsSweep", value: { config: {} } })).toBe(true)
    expect(
      takes({ key: "jobs.opsSweep", value: { config: { hours: "09-18", made: ["up"] } } }),
    ).toBe(true)
  })

  test("refuses a config that is not an object, and a config beside another field (#1336)", () => {
    for (const value of [
      { config: [] },
      { config: "hours=09-18" },
      { config: null },
      { config: 7 },
      { config: {}, enabled: true },
    ]) {
      expect(takes({ key: "jobs.opsSweep", value }), JSON.stringify(value)).toBe(false)
    }
  })
})

// PG-1363: the guard decision also places an org's own job, a whole row the setting's write then checks against the org's script folders.
describe("a guard decision for an org's own job (PG-1363)", () => {
  const takes = (change: object) =>
    inboxInputSchema.safeParse(decision({ ...GUARD, ...change })).success
  const row = {
    callsModel: false,
    command: "{bun} --no-env-file {data}/ops/ops-watch/cli.ts",
    description: "Watches a made-up org's queue.",
    enabled: true,
    heartbeat: "ops-watch",
    schedule: { every: 60 },
  }

  test("takes a whole job row for a job the registry lacks, or no value", () => {
    expect(takes({ key: "jobs.opsWatch", value: row })).toBe(true)
    expect(takes({ key: "jobs.opsWatch", value: { ...row, config: { prefixes: ["X"] } } })).toBe(
      true,
    )
    expect(takes({ key: "jobs.opsWatch", value: undefined })).toBe(true)
  })

  test("takes its enabled field alone or its config alone, which Approve writes over the org's row (#1336)", () => {
    expect(takes({ key: "jobs.opsWatch", value: { enabled: false } })).toBe(true)
    expect(takes({ key: "jobs.opsWatch", value: { config: { prefixes: ["X"] } } })).toBe(true)
  })

  test("refuses a row that is no job, a config that is no object, and a key that is no job's name", () => {
    for (const change of [
      { key: "jobs.opsWatch", value: { config: {}, enabled: true } },
      { key: "jobs.opsWatch", value: { config: ["X"] } },
      { key: "jobs.opsWatch", value: { ...row, config: ["X"] } },
      { key: "jobs.opsWatch", value: { ...row, madeUp: 1 } },
      { key: "jobs.ops-watch", value: row },
      { key: "jobs.", value: row },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })
})

// Made-up accounts: two Claude rows, one of them own, and a GLM row whose label is no Claude email.
const ACCOUNTS = [
  { email: "pat@example.com", label: "work", renews: 17 },
  { email: "sam@example.com", own: true },
  { label: "zai", provider: "glm" },
]
const OWN = {
  key: "pat@example.com",
  own: true,
  scope: "made-up-me",
  type: "own",
  why: "Spend the org's accounts first",
}

describe("an own decision (PG-1162)", () => {
  const takes = (change: object) =>
    inboxInputSchema.safeParse(decision({ ...OWN, ...change })).success

  test("carries one account's email, the flag Approve leaves it with, its scope and why", () => {
    expect(takes({})).toBe(true)
    expect(takes({ own: false })).toBe(true)
    expect(takes({ scope: "acme-test" })).toBe(true)
  })

  test("refuses a key that is no email, a flag that is no boolean, core as its scope, no why and any other field", () => {
    for (const change of [
      { key: "zai" },
      { key: "" },
      { own: "yes" },
      { own: undefined },
      { scope: "core" },
      { why: "" },
      { rows: ACCOUNTS },
    ]) {
      expect(takes(change), JSON.stringify(change)).toBe(false)
    }
  })

  test("is approved, denied or cleared as it reads, never edited, and stays off the relay", () => {
    const open = { kind: "decision", preview: OWN, status: "open" } as never
    expect(checkAnswer(open, { action: "deny" })).toMatchObject({ status: "denied" })
    expect(checkAnswer(open, { action: "edit", text: "another account" })).toHaveProperty("message")
    expect(RELAY_ANSWER_KINDS as readonly string[]).not.toContain("own")
  })
})

// The store against a throwaway Postgres in Docker published on 127.0.0.1 only, migrated as the dashboard's is, so the table's own rules hold. Skipped where Docker is not running.
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")
// made at run time, so no password is ever written into the repo
const PASSWORD = crypto.randomUUID()

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

// PG-649: a Slack send uploads its files into the link's channel and thread
describe("slackPlace", () => {
  test("reads a thread's channel and its parent's ts from the app form", () => {
    expect(
      slackPlace(
        "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100",
      ),
    ).toEqual({ channel: "C0MADEUP01", thread: "1700000000.000100" })
  })

  test("reads a channel or a DM with no thread as its top level", () => {
    expect(slackPlace(CHANNEL)).toEqual({ channel: "C0MADEUP01" })
    expect(slackPlace("https://app.slack.com/client/T0000000000/D0MADEUP11")).toEqual({
      channel: "D0MADEUP11",
    })
  })

  test("reads past a query or a hash, as the web's card does", () => {
    expect(slackPlace(`${CHANNEL}?cdn_fallback=1#top`)).toEqual({ channel: "C0MADEUP01" })
  })

  // a reply that goes in a thread its files would miss: they would land at the conversation's top level
  test("is null for a thread part that does not parse, so the files never land outside the reply's thread", () => {
    for (const bad of [
      `${CHANNEL}/thread/C0MADEUP01-notats`,
      `${CHANNEL}/thread/C0MADE0101-1700000000.000100`,
      `${CHANNEL}/thread`,
      `${CHANNEL}/thread/C0MADEUP01-1700000000.000100/more`,
      `${CHANNEL}/files/F0MADEUP01`,
    ])
      expect(slackPlace(bad)).toBeNull()
  })

  test("is null for no link, a place outside Slack, or a Slack link that names no conversation", () => {
    expect(slackPlace(undefined)).toBeNull()
    expect(slackPlace("https://linear.app/acme/issue/MADEDUNE-1401")).toBeNull()
    expect(slackPlace("https://app.slack.com/client/T0000000000")).toBeNull()
    expect(slackPlace("https://evil.example/client/T0000000000/C0MADEUP01")).toBeNull()
  })
})

describe.skipIf(!dockerUp())("the inbox store", () => {
  let container = ""
  let store: typeof import("../../../../../../api/hono/src/lib/dashboard/inbox")
  let db: ReturnType<typeof import("../../../../../../packages/db/dist/index.mjs").createDatabase>
  const actor = { email: "owner@local.host", id: "owner" }
  let url = ""

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("inbox"),
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
    for (let i = 0; i < 240; i++) {
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
        if (statement.trim()) await admin!.unsafe(statement)
      }
    }
    await admin!.close()
    store = await import("../../../../../../api/hono/src/lib/dashboard/inbox")
    db = (await import("../../../../../../packages/db/dist/index.mjs")).createDatabase(url)
  }, 180_000)

  afterAll(() => {
    if (container)
      Bun.spawnSync(["docker", "rm", "-f", "-v", container], { stderr: "ignore", stdout: "ignore" })
  })

  const post = async (input: object) => {
    const posted = await store.postItem(db, input)
    if (!posted.ok) throw new Error(posted.message)
    return posted.item
  }

  // the Done when of #974, end to end: post during focus, end it, read the card
  test("an item posted while focus stands is stored and left out of the count, an alert counts, and once focus ends its card comes and the item counts (#974)", async () => {
    const { focusCard } = await import("../../../../../../packages/scripts/src/playground/focus")
    const data = mkdtempSync(join(tmpdir(), "inbox-focus-"))
    const during = await post(decision(PREVIEWS.ask))
    // focus began as that item came in, by the database's own clock, so no older item reads as quiet
    const since = Date.parse(during.createdAt)
    const until = new Date(since + 30 * 60_000)
    writeFileSync(
      join(data, "focus.json"),
      JSON.stringify({
        reason: "a timed demo",
        session: "worker-f",
        since: during.createdAt,
        until: until.toISOString(),
      }),
    )
    const alert = await post({
      from: "ops",
      kind: "update",
      preview: { outcome: "alert" },
      title: "The Mac's battery is at 5%: plug it in now or it shuts down",
    })
    const at = new Date(since + 60_000)
    const focus = await standingFocus(data, at)
    expect(focus?.session).toBe("worker-f")
    const quiet = await store.listItems(db, at, focus)
    const loud = await store.listItems(db, at)
    expect(quiet.items.map((item) => item.id)).toContain(during.id)
    expect(quiet.quiet).toEqual([during.id])
    expect(quiet.count).toBe(loud.count - 1)
    expect(loud.items.map((item) => item.id)).toContain(alert.id)

    const posted = await focusCard(data, until, async (card) => {
      await post({ from: "ops", ...card })
    })
    expect(posted).toBe("posted")
    expect(await standingFocus(data, until)).toBeNull()
    const after = await store.listItems(db, until, await standingFocus(data, until))
    expect(after.quiet).toEqual([])
    expect(after.items.map((item) => item.title)).toContain(
      "Focus for worker-f ended: 0 runs queued while it stood, 0m0s in all",
    )
    expect(after.items.map((item) => item.id)).toContain(during.id)
    expect(after.count).toBe((await store.listItems(db, until)).count)
    rmSync(data, { force: true, recursive: true })
  })

  test("a kept file downloads under its item's title, the file's own name after it when the item carries several, and as attachment when no item carries it (#783)", async () => {
    const lone = "3f0e7a52-1c4b-4d2a-9e6f-00000000d001.html"
    const shot = "3f0e7a52-1c4b-4d2a-9e6f-00000000d002.png"
    const notes = "3f0e7a52-1c4b-4d2a-9e6f-00000000d003.pdf"
    await post({
      from: "ops",
      kind: "update",
      preview: { attachments: [{ id: lone, kind: "html", name: "deck.html" }], outcome: "finding" },
      title: "Weekly plan: updated draft",
    })
    await post({
      from: "ops",
      kind: "update",
      preview: {
        attachments: [
          { id: shot, kind: "image", name: "card-after.png" },
          { id: notes, kind: "pdf", name: "notes.v2.pdf" },
        ],
        outcome: "finding",
      },
      title: "Sidebar spacing",
    })
    expect(await store.attachmentDownloadName(db, lone)).toBe("Weekly plan updated draft.html")
    expect(await store.attachmentDownloadName(db, shot)).toBe("Sidebar spacing, card-after.png")
    expect(await store.attachmentDownloadName(db, notes)).toBe("Sidebar spacing, notes.v2.pdf")
    expect(await store.attachmentDownloadName(db, "3f0e7a52-1c4b-4d2a-9e6f-00000000d004.png")).toBe(
      "attachment.png",
    )
    await post({
      from: "ops",
      kind: "update",
      preview: { attachments: [{ id: lone, kind: "html", name: "deck.html" }], outcome: "finding" },
      title: "Weekly plan, final",
    })
    expect(await store.attachmentDownloadName(db, lone)).toBe("Weekly plan, final.html")
  })

  test("an item gets a tag that counts up, and is found by its id or its tag", async () => {
    const a = await post(decision(SLACK))
    const b = await post(decision(PREVIEWS.ship))
    expect(b.ref).toBe(a.ref + 1)
    expect(a.status).toBe("open")
    expect((await store.getItem(db, a.id))?.id).toBe(a.id)
    expect((await store.getItem(db, `#i${b.ref}`))?.id).toBe(b.id)
    expect((await store.getItem(db, `i${b.ref}`))?.id).toBe(b.id)
    expect(await store.getItem(db, "#i999999")).toBeNull()
  })

  test("Approve hands the item to the session that posted it, and the dashboard sends nothing itself", async () => {
    const posted = await post(decision(SLACK))
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: "2026-10-07T12:00:00.000Z", ok: true, sessionId: "s1" }
        },
      },
    )
    expect(answered.ok).toBe(true)
    // one delivery, to the poster, never to the Slack recipient the preview names
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe("ops")
    expect(sent[0]?.text).toContain(`#i${posted.ref}`)
    if (!answered.ok) return
    expect(answered.item.status).toBe("approved")
    expect(answered.item.answer).toMatchObject({ choice: "approve" })
    expect(answered.item.delivery).toEqual({
      at: "2026-10-07T12:00:00.000Z",
      status: "delivered",
      to: "ops",
      via: "session",
    })
  })

  test("a multi-question ask stores one pick per question and tells its poster each, with the Note (#1250)", async () => {
    const posted = await post(
      decision({
        questions: [
          { options: [{ label: "staging" }, { label: "main" }], question: "Base?" },
          {
            options: [{ label: "now" }, { label: "later" }, { label: "soon" }],
            question: "When?",
          },
        ],
        text: "Pick for each.",
        type: "ask",
      }),
    )
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve", note: "both fine", options: [0, 2] },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: "2026-10-07T12:00:00.000Z", ok: true, sessionId: "s1" }
        },
      },
    )
    expect(answered.ok).toBe(true)
    if (!answered.ok) return
    expect(answered.item.status).toBe("approved")
    expect(answered.item.answer).toMatchObject({
      choice: "approve",
      note: "both fine",
      options: [0, 2],
    })
    // read the stored answer back: one index per question, and the Note
    const got = await store.getItem(db, posted.id)
    expect(got?.answer).toMatchObject({ choice: "approve", note: "both fine", options: [0, 2] })
    // the poster is told each pick by its letter and label, and the Note as a comment
    const payload = payloadOf(sent[0]?.text ?? "")
    expect(payload?.picks).toEqual([
      { index: 0, label: "staging", letter: "A", question: "Base?" },
      { index: 2, label: "soon", letter: "C", question: "When?" },
    ])
    expect(payload?.comment).toBe("both fine")
  })

  describe("a Slack send's files (PG-649)", () => {
    const THREAD =
      "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
    const FILES = [
      { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png", kind: "image", name: "before.png" },
      { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a2.png", kind: "image", name: "after.png" },
    ]
    const delivered = async () =>
      ({ at: "2026-10-07T12:00:00.000Z", ok: true, sessionId: "s1" }) as const
    const filedDraft = (link = THREAD) =>
      post({
        from: "ops",
        kind: "draft",
        preview: { attachments: FILES, link, text: "the fix is live", to: "@Merritt" },
        title: "Tell Merritt",
      })
    // the upload is handed the answered item alone, as dm upload is handed its id
    const recorder = (fail?: string) => {
      const calls: string[] = []
      const upload = async (item: { id: string }) => {
        calls.push(item.id)
        if (fail) throw new Error(fail)
        return FILES.length
      }
      return { calls, upload }
    }

    test("Send uploads the files into the link's channel and thread before the words reach the poster, and the answer keeps the count", async () => {
      const posted = await filedDraft()
      const order: string[] = []
      const { calls, upload } = recorder()
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "send" },
        {
          actor,
          deliver: async () => {
            order.push("typed")
            return delivered()
          },
          upload: async (item) => {
            order.push("uploaded")
            return upload(item)
          },
        },
      )
      expect(order).toEqual(["uploaded", "typed"])
      expect(calls).toEqual([posted.id])
      if (!answered.ok) throw new Error("not answered")
      expect(answered.item.answer).toMatchObject({ choice: "send", uploaded: 2 })
      expect(answered.item.delivery).toMatchObject({ status: "delivered" })
    })

    test("a failed upload fails the send before anything is typed, and Retry uploads again, then types", async () => {
      const posted = await filedDraft()
      const typed: Delivery[] = []
      const deliver = async (delivery: Delivery) => {
        typed.push(delivery)
        return delivered()
      }
      const failing = recorder("files.completeUploadExternal: not_in_channel")
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "send" },
        { actor, deliver, upload: failing.upload },
      )
      if (!answered.ok) throw new Error("not answered")
      expect(typed).toEqual([])
      expect(answered.item.delivery).toEqual({
        code: "UPLOAD_FAILED",
        reason: "The files did not upload to Slack: files.completeUploadExternal: not_in_channel",
        status: "failed",
      })
      expect(store.retryable(answered.item)).toBe(true)
      const working = recorder()
      const retried = await store.retryDelivery(db, posted.id, {
        actor,
        deliver,
        upload: working.upload,
      })
      if (!retried.ok) throw new Error("not retried")
      expect(working.calls).toHaveLength(1)
      expect(typed).toHaveLength(1)
      expect(retried.item.delivery).toMatchObject({ status: "delivered" })
      expect(retried.item.answer).toMatchObject({ uploaded: 2 })
    })

    test("a Retry after the words failed to type keeps the files it uploaded, uploading none twice", async () => {
      const posted = await filedDraft()
      const { calls, upload } = recorder()
      const failed = await store.answerItem(
        db,
        posted.id,
        { action: "send" },
        {
          actor,
          deliver: async () => ({ code: "ON_PICKER", ok: false, reason: "A picker is open." }),
          upload,
        },
      )
      if (!failed.ok) throw new Error("not answered")
      expect(failed.item.delivery).toMatchObject({ code: "ON_PICKER", status: "failed" })
      await store.retryDelivery(db, posted.id, { actor, deliver: delivered, upload })
      expect(calls).toHaveLength(1)
    })

    test("Approve of a slack decision with files uploads them too", async () => {
      const posted = await post(decision({ ...SLACK, attachments: FILES }))
      const { calls, upload } = recorder()
      await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        { actor, deliver: delivered, upload },
      )
      expect(calls).toEqual([posted.id])
    })

    // what dm upload shares comes from the stored item alone: it takes an id, never a channel, a thread or a path
    describe("uploadSpec", () => {
      const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      let dir = ""
      const read = (id: string) => readAttachment(id, dir)
      const kept = async (bytes: Uint8Array, name: string, kind: string) => {
        const stored = await storeAttachment(bytes, name, { dir })
        if (!stored.ok) throw new Error("not stored")
        // its mtime on the test's clock, which the next store's sweep ages it by, so the clock-ahead pass reads it as just stored
        utimesSync(join(dir, stored.id), new Date(), new Date())
        return { id: stored.id, kind, name }
      }
      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "pg-649-files-"))
      })
      afterAll(() => {
        if (dir) rmSync(dir, { force: true, recursive: true })
      })

      test("reads the place from the sent item's link and each file's bytes from the attachments folder, its text told by the kept file's kind", async () => {
        const shot = await kept(PNG, "before.png", "image")
        // text bytes under a picture's name: the folder keeps them as .txt, so the guard reads their words
        const notes = await kept(
          new TextEncoder().encode("the fix is live\n"),
          "notes.png",
          "image",
        )
        const posted = await post({
          from: "ops",
          kind: "draft",
          preview: { attachments: [shot, notes], link: THREAD, text: "hi", to: "@Merritt" },
          title: "Tell Merritt",
        })
        await store.answerItem(db, posted.id, { action: "send" }, { actor })
        const spec = await uploadSpec(db, posted.id, read)
        expect(spec).toEqual({
          channel: "C0MADEUP01",
          files: [
            { bytes: Buffer.from(PNG).toString("base64"), name: "before.png", text: false },
            {
              bytes: Buffer.from("the fix is live\n").toString("base64"),
              name: "notes.png",
              text: true,
            },
          ],
          thread: "1700000000.000100",
        })
      })

      test("refuses an id naming no item, a channel, a thread or a path, so no caller picks the place or the file", async () => {
        for (const id of ["C0MADEUP01", THREAD, join(dir, "x.png"), "/etc/hosts", "#i999999"])
          await expect(uploadSpec(db, id, read)).rejects.toThrow("no Inbox item")
      })

      test("refuses a Send whose words already went, as every Send from before this PR did", async () => {
        const shot = await kept(PNG, "before.png", "image")
        const old = await post({
          from: "ops",
          kind: "draft",
          preview: { attachments: [shot], link: THREAD, text: "hi", to: "@Merritt" },
          title: "Sent before",
        })
        await store.answerItem(db, old.id, { action: "send" }, { actor, deliver: delivered })
        await expect(uploadSpec(db, old.id, read)).rejects.toThrow("not in flight")
      })

      test("refuses an item still open, denied, already shared, or whose file left the folder", async () => {
        const shot = await kept(PNG, "before.png", "image")
        const draft = { attachments: [shot], link: THREAD, text: "hi", to: "@Merritt" }
        const open = await post({ from: "ops", kind: "draft", preview: draft, title: "Open" })
        await expect(uploadSpec(db, open.id, read)).rejects.toThrow("holds no files")
        const denied = await post(decision({ ...SLACK, attachments: [shot] }))
        await store.answerItem(db, denied.id, { action: "deny" }, { actor })
        await expect(uploadSpec(db, denied.id, read)).rejects.toThrow("holds no files")
        const shared = await post({ from: "ops", kind: "draft", preview: draft, title: "Shared" })
        await store.answerItem(
          db,
          shared.id,
          { action: "send" },
          { actor, deliver: delivered, upload: async () => 1 },
        )
        await expect(uploadSpec(db, shared.id, read)).rejects.toThrow("holds no files")
        const gone = await post({
          from: "ops",
          kind: "draft",
          preview: { ...draft, attachments: [{ ...shot, id: `${crypto.randomUUID()}.png` }] },
          title: "Gone",
        })
        await store.answerItem(db, gone.id, { action: "send" }, { actor })
        await expect(uploadSpec(db, gone.id, read)).rejects.toThrow(
          "before.png is gone from the attachments folder",
        )
      })
    })

    test("a Slack draft saved as a draft, a Linear draft, a Deny and a Send whose link's thread part does not parse upload nothing, the last still delivering its words", async () => {
      const { calls, upload } = recorder()
      const saved = await filedDraft()
      await store.answerItem(
        db,
        saved.id,
        { action: "draft" },
        { actor, deliver: delivered, upload },
      )
      const linear = await filedDraft("https://linear.app/acme/issue/MADEDUNE-1401")
      await store.answerItem(
        db,
        linear.id,
        { action: "send" },
        { actor, deliver: delivered, upload },
      )
      const denied = await post(decision({ ...SLACK, attachments: FILES }))
      await store.answerItem(
        db,
        denied.id,
        { action: "deny" },
        { actor, deliver: delivered, upload },
      )
      const broken = await filedDraft(`${CHANNEL}/thread/C0MADEUP01-notats`)
      const sent = await store.answerItem(
        db,
        broken.id,
        { action: "send" },
        { actor, deliver: delivered, upload },
      )
      if (!sent.ok) throw new Error("not answered")
      expect(sent.item.delivery).toMatchObject({ status: "delivered" })
      expect(sent.item.answer).not.toHaveProperty("uploaded")
      expect(calls).toEqual([])
    })
  })

  test("a second answer is refused, so a double click cannot answer twice", async () => {
    const posted = await post(decision(PREVIEWS.delete))
    const [one, two] = await Promise.all([
      store.answerItem(db, posted.id, { action: "approve" }, { actor }),
      store.answerItem(db, posted.id, { action: "deny" }, { actor }),
    ])
    expect([one.ok, two.ok].sort()).toEqual([false, true])
    const again = await store.answerItem(db, posted.id, { action: "deny" }, { actor })
    expect(again).toMatchObject({ code: "CONFLICT", ok: false })
  })

  test("Dismiss records the moment in an answered item's answer, so it stays in Done after a reload, and leaves an open decision or draft", async () => {
    const answered = await post(decision(PREVIEWS.budget))
    await store.answerItem(db, answered.id, { action: "deny" }, { actor })
    const open = await post(decision(PREVIEWS.schema))
    const draft = await post({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
      title: "Ask Merritt",
    })
    const at = new Date("2026-10-07T12:00:00.000Z")
    expect(await store.dismissItems(db, [answered.id, open.id, draft.id], at)).toBe(1)
    const after = await store.getItem(db, answered.id)
    expect(after?.answer).toMatchObject({ choice: "deny", dismissedAt: at.toISOString() })
    expect(after?.status).toBe("denied")
    expect((await store.getItem(db, open.id))?.answer).toBeNull()
    expect((await store.getItem(db, draft.id))?.answer).toBeNull()
    expect((await store.getItem(db, draft.id))?.status).toBe("open")
    // a second dismissal changes nothing, and the list a reload reads carries it
    expect(await store.dismissItems(db, [answered.id])).toBe(0)
    const listed = (await store.listItems(db, at)).items.find((item) => item.id === answered.id)
    expect(listed?.answer).toMatchObject({ dismissedAt: at.toISOString() })
  })

  // Mark as read keeps the message as it is and drops the double tick.
  test("Mark all as read marks every unread ask, draft and update seen, answering and dismissing none, so each stays as it is", async () => {
    const ask = await post(decision(PREVIEWS.ask))
    const draft = await post({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
      title: "Ask Merritt",
    })
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged",
    })
    const at = new Date()
    expect(await store.markRead(db, [ask.id, draft.id, update.id], at)).toBe(3)
    const listed = (await store.listItems(db, at)).items.filter((item) =>
      [ask.id, draft.id, update.id].includes(item.id),
    )
    expect(listed).toHaveLength(3)
    for (const item of listed) expect(item.readAt).toBe(at.toISOString())
    for (const item of [ask, draft].map((posted) => listed.find((i) => i.id === posted.id)))
      expect(item).toMatchObject({ answer: null, status: "open" })
  })

  // a reviewer: a read moved updatedAt, so a card read a second on flipped from posted to updated
  test("Mark as read leaves an ask's updatedAt as posted, so its card never reads updated, while an update's moves", async () => {
    const ask = await post(decision(PREVIEWS.ask))
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged",
    })
    const later = new Date(Date.parse(ask.createdAt) + 5000)
    expect(await store.markRead(db, [ask.id, update.id], later)).toBe(2)
    const listed = (await store.listItems(db, later)).items
    const read = listed.find((item) => item.id === ask.id)
    expect(read?.updatedAt).toBe(ask.updatedAt)
    expect(read?.readAt).toBe(later.toISOString())
    expect(listed.find((item) => item.id === update.id)?.updatedAt).toBe(later.toISOString())
  })

  // An item answered from chat can still be dismissed.
  test("Dismiss takes an item he replied to in chat, still open, and keeps the reply for its poster", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    const repliedAt = new Date("2026-10-07T11:00:00.000Z")
    await store.recordReply(db, posted.ref, repliedAt)
    const at = new Date("2026-10-07T12:00:00.000Z")
    expect(await store.dismissItems(db, [posted.id], at)).toBe(1)
    const after = await store.getItem(db, posted.id)
    expect(after?.answer).toEqual({
      at: repliedAt.toISOString(),
      choice: "replied",
      dismissedAt: at.toISOString(),
    })
    expect(after?.status).toBe("open")
    expect(await store.dismissItems(db, [posted.id])).toBe(0)
  })

  test("Dismiss takes an update, read or not: it records the moment, marks it read and keeps the time it was read", async () => {
    const posted = () =>
      post({ from: "builder", kind: "update", preview: { outcome: "merged" }, title: "Merged" })
    const unread = await posted()
    const read = await posted()
    const readAt = new Date("2026-10-07T11:00:00.000Z")
    await store.markRead(db, [read.id], readAt)
    const at = new Date("2026-10-07T12:00:00.000Z")
    expect(await store.dismissItems(db, [unread.id, read.id], at)).toBe(2)
    const gone = await store.getItem(db, unread.id)
    expect(gone?.answer).toEqual({ dismissedAt: at.toISOString() })
    expect(gone?.readAt).toBe(at.toISOString())
    expect(gone?.status).toBe("done")
    const kept = await store.getItem(db, read.id)
    expect(kept?.answer).toEqual({ dismissedAt: at.toISOString() })
    expect(kept?.readAt).toBe(readAt.toISOString())
    // a second dismissal changes nothing, and the poster's ack still finds no answer on it
    expect(await store.dismissItems(db, [unread.id])).toBe(0)
    expect(await store.ackItem(db, unread.id)).toMatchObject({ code: "CONFLICT", ok: false })
  })

  test("the poster settles its own open item, which then takes no answer; an answered one or an update is refused", async () => {
    const posted = await post(decision(PREVIEWS.ticket))
    const at = new Date("2026-10-07T12:00:00.000Z")
    const settled = await store.settleItem(db, `#i${posted.ref}`, {
      note: "Filed by hand",
      now: at,
    })
    expect(settled.ok).toBe(true)
    if (!settled.ok) return
    expect(settled.item.status).toBe("done")
    expect(settled.item.answer).toEqual({
      at: at.toISOString(),
      by: "ops",
      choice: "settled",
      dismissedAt: at.toISOString(),
      note: "Filed by hand",
    })
    expect(settled.item.delivery).toBeNull()
    expect(await store.answerItem(db, posted.id, { action: "approve" }, { actor })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    expect(await store.settleItem(db, posted.id)).toMatchObject({ code: "CONFLICT", ok: false })
    const answered = await post(decision(PREVIEWS.budget))
    await store.answerItem(db, answered.id, { action: "approve" }, { actor })
    expect(await store.settleItem(db, answered.id)).toMatchObject({ code: "CONFLICT", ok: false })
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "finding" },
      title: "Found",
    })
    await store.markRead(db, [update.id])
    expect(await store.settleItem(db, update.id)).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    expect(
      await store.settleItem(db, (await post(decision(SLACK))).id, { note: "two\nlines" }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(
      await store.settleItem(db, (await post(decision(SLACK))).id, {
        note: "Sent in https://acme.slack.com/archives/C0MADEUP01",
      }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
  })

  test("the poster edits its own item in place, bumping updatedAt and version; another session's, a closed item and a bad shape are refused (PG-2547)", async () => {
    const posted = await post(decision(SLACK))
    const at = new Date(Date.parse(posted.updatedAt) + 60_000)
    const edited = await store.editItem(
      db,
      `#i${posted.ref}`,
      {
        ...decision({ ...SLACK, text: "hi Merritt, the fix is live." }),
        title: "Send Merritt the live note?",
      },
      at,
    )
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.item).toMatchObject({
      id: posted.id,
      preview: { text: "hi Merritt, the fix is live." },
      status: "open",
      title: "Send Merritt the live note?",
      updatedAt: at.toISOString(),
      version: posted.version + 1,
    })
    expect((await store.editItem(db, posted.id, decision(SLACK)))?.ok).toBe(true)
    // another session's item, a change of kind and a bad shape are refused, leaving the item as it was
    expect(
      await store.editItem(db, posted.id, { ...decision(SLACK), from: "builder" }),
    ).toMatchObject({ code: "CONFLICT", ok: false })
    expect(
      await store.editItem(db, posted.id, {
        ...decision(SLACK),
        kind: "update",
        preview: { outcome: "finding" },
      }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(
      await store.editItem(db, posted.id, { ...decision(SLACK), preview: { type: "slack" } }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(await store.editItem(db, "#i999999", decision(SLACK))).toMatchObject({
      code: "NOT_FOUND",
      ok: false,
    })
    // a settled decision is refused
    const settled = await post(decision(SLACK))
    await store.settleItem(db, settled.id)
    expect(await store.editItem(db, settled.id, decision(SLACK))).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    // an update edits while it stands, and is refused once dismissed
    const progress = {
      from: "builder",
      kind: "update",
      preview: { outcome: "finding", text: "40%" },
      title: "Round 2",
    }
    const update = await post(progress)
    const moved = await store.editItem(db, update.id, {
      ...progress,
      preview: { outcome: "finding", text: "80%" },
    })
    expect(moved).toMatchObject({ item: { preview: { text: "80%" }, status: "done" }, ok: true })
    await store.dismissItems(db, [update.id])
    expect(await store.editItem(db, update.id, progress)).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
  })

  test("an answer to a card its poster edited since he read it is refused, and one to the card as it stands lands (PG-2547)", async () => {
    const posted = await post(decision(SLACK))
    const edited = await store.editItem(
      db,
      posted.id,
      decision({ ...SLACK, text: "hi Merritt, a different message." }),
      new Date(Date.parse(posted.updatedAt) + 60_000),
    )
    if (!edited.ok) throw new Error(edited.message)
    expect(
      await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: posted.updatedAt },
        { actor },
      ),
    ).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("changed since"),
      ok: false,
    })
    expect((await store.getItem(db, posted.id))?.status).toBe("open")
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve", seen: edited.item.updatedAt },
      { actor },
    )
    expect(answered).toMatchObject({ item: { status: "approved" }, ok: true })
  })

  test("an item put away with Later edits as an open one, and so does one replied to in chat (PG-2547, #903)", async () => {
    const snoozed = await post(decision(SLACK))
    const scheduled = await store.scheduleItem(
      db,
      snoozed.id,
      new Date(Date.now() + 3_600_000).toISOString(),
    )
    if (!scheduled.ok) throw new Error(scheduled.message)
    expect(await store.editItem(db, snoozed.id, decision(SLACK))).toMatchObject({
      item: { answer: { snoozedUntil: expect.any(String) }, status: "open" },
      ok: true,
    })
    // settled, so no open item sleeps past the other tests' clocks
    expect(await store.settleItem(db, snoozed.id)).toMatchObject({ ok: true })
    const replied = await post(decision(SLACK))
    await store.recordReply(db, replied.ref)
    expect(await store.editItem(db, replied.id, decision(SLACK))).toMatchObject({ ok: true })
  })

  describe("an item stays editable until it closes (#903)", () => {
    const progress = {
      from: "builder",
      kind: "update",
      preview: { outcome: "finding", text: "40%" },
      title: "Round 2",
    }
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

    test("an update edits while archived and put away with Later, and is refused once Done or dismissed", async () => {
      const update = await post(progress)
      await store.markRead(db, [update.id])
      expect(await store.answerItem(db, update.id, { action: "archive" }, { actor })).toMatchObject(
        { ok: true },
      )
      expect(await store.editItem(db, update.id, progress)).toMatchObject({ ok: true })
      expect((await store.scheduleItem(db, update.id, at(60))).ok).toBe(true)
      expect(await store.editItem(db, update.id, progress)).toMatchObject({
        item: { answer: { snoozedUntil: expect.any(String) } },
        ok: true,
      })
      await store.dismissItems(db, [update.id])
      expect(await store.editItem(db, update.id, progress)).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
      const other = await post(progress)
      expect(await store.answerItem(db, other.id, { action: "dismiss" }, { actor })).toMatchObject({
        ok: true,
      })
      expect(await store.editItem(db, other.id, progress)).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
    })

    test("an answered ask edits while it is being carried out, and is refused once its poster closes it or the owner dismisses it", async () => {
      const denied = await post(decision(SLACK))
      expect(await store.answerItem(db, denied.id, { action: "deny" }, { actor })).toMatchObject({
        ok: true,
      })
      const moved = await store.editItem(
        db,
        denied.id,
        decision({ ...SLACK, text: "hi, 2 of 3 done." }),
      )
      expect(moved).toMatchObject({
        item: { preview: { text: "hi, 2 of 3 done." }, status: "denied" },
        ok: true,
      })
      expect((await store.ackItem(db, denied.id)).ok).toBe(true)
      expect(await store.editItem(db, denied.id, decision(SLACK))).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
      const approved = await post(decision(SLACK))
      expect(
        await store.answerItem(db, approved.id, { action: "approve" }, { actor }),
      ).toMatchObject({ ok: true })
      expect(await store.editItem(db, approved.id, decision(SLACK))).toMatchObject({ ok: true })
      expect(
        await store.answerItem(db, approved.id, { action: "dismiss" }, { actor }),
      ).toMatchObject({ ok: true })
      expect(await store.editItem(db, approved.id, decision(SLACK))).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
    })
  })

  test("a chat reply keeps his words after the tag, so the card says what is being done", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    const at = new Date("2026-10-07T12:00:00.000Z")
    const recorded = await store.recordReply(
      db,
      posted.ref,
      at,
      `re #i${posted.ref}:  tomorrow,\n after the standup`,
    )
    expect(recorded?.answer).toEqual({
      at: at.toISOString(),
      choice: "replied",
      said: "tomorrow, after the standup",
    })
    expect(store.saidOf(`re #i${posted.ref}`)).toBeUndefined()
    expect(store.saidOf("x".repeat(400))).toHaveLength(280)
  })

  test("a chat reply records itself on the open item, which then waits on its poster alone", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    const at = new Date("2026-10-07T12:00:00.000Z")
    const recorded = await store.recordReply(db, posted.ref, at)
    if (!recorded) throw new Error("the reply was not recorded")
    expect(recorded.answer).toEqual({ at: at.toISOString(), choice: "replied" })
    expect(recorded.status).toBe("open")
    expect(recorded.delivery).toBeNull()
    // it stays in the list, but the count and what needs him leave it
    const listed = await store.listItems(db, at)
    expect(listed.items.map((i) => i.id)).toContain(posted.id)
    expect(listed.count).toBe(store.inboxCount(listed.items))
    expect(listed.items.filter(store.deliveryFailed)).toHaveLength(0)
    // a second reply, an answered item, an update and an unknown tag take none
    expect(await store.recordReply(db, posted.ref, new Date(at.getTime() + 60_000))).toBeNull()
    const other = await post(decision(PREVIEWS.delete))
    await store.answerItem(db, other.id, { action: "approve" }, { actor })
    expect(await store.recordReply(db, other.ref, at)).toBeNull()
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged",
    })
    expect(await store.recordReply(db, update.ref, at)).toBeNull()
    expect(await store.recordReply(db, 999999, at)).toBeNull()
    await store.markRead(db, [update.id])
    // its poster closes it: a chat reply is no go, so a bare ack closes it, and its delivery is done by the CLI
    const closed = await store.ackItem(db, posted.id, { now: new Date(at.getTime() + 60_000) })
    if (!closed.ok) throw new Error(closed.message)
    expect(closed.item.answer).toMatchObject({
      ackedAt: "2026-10-07T12:01:00.000Z",
      choice: "replied",
    })
    expect(closed.item.delivery).toMatchObject({ status: "delivered", via: "cli" })
    // and a settle still takes one its poster decided another way
    const settled = await post(decision(PREVIEWS.schema))
    await store.recordReply(db, settled.ref, at)
    const done = await store.settleItem(db, settled.id, { note: "Decided another way" })
    expect(done.ok && done.item.status).toBe("done")
    expect(done.ok && done.item.answer).toMatchObject({ choice: "settled" })
  })

  test("an answered item its poster closes moves to Done at once; one not carried out yet stays (PG-2502)", async () => {
    const at = new Date("2026-10-28T19:00:00.000Z")
    const answered = async (preview: object, action: "approve" | "deny") => {
      const posted = await post(decision(preview))
      await store.answerItem(db, posted.id, { action }, { actor })
      return (await store.getItem(db, posted.id))!
    }
    const dismissed = (item: { answer: unknown } | null | undefined) =>
      (item?.answer as { dismissedAt?: string } | null)?.dismissedAt
    // bun run ask ack: a go closed with where it landed
    const go = await answered(PREVIEWS.delete, "approve")
    const acked = await store.ackItem(db, go.id, { link: CHANNEL, now: at })
    if (!acked.ok) throw new Error(acked.message)
    expect(dismissed(acked.item)).toBe(at.toISOString())
    // bun run ask get --ack: a deny, which reading carries out
    const denied = await answered(PREVIEWS.budget, "deny")
    expect(dismissed(await store.readAnswer(db, denied, at))).toBe(at.toISOString())
    // bun run ask ack on a chat reply, which skips In progress for Done
    const replied = await post(decision(PREVIEWS.ticket))
    await store.recordReply(db, replied.ref, new Date(at.getTime() - 60_000))
    const closed = await store.ackItem(db, replied.id, { now: at })
    if (!closed.ok) throw new Error(closed.message)
    expect(dismissed(closed.item)).toBe(at.toISOString())
    // bun run ask settle: the poster decided it another way
    const open = await post(decision(PREVIEWS.schema))
    const settled = await store.settleItem(db, open.id, { now: at })
    if (!settled.ok) throw new Error(settled.message)
    expect(dismissed(settled.item)).toBe(at.toISOString())
    // a go read but not carried out, and an answer no one closed, stay in the list
    const read = await answered(PREVIEWS.delete, "approve")
    await store.readAnswer(db, read, at)
    expect(dismissed(await store.getItem(db, read.id))).toBeUndefined()
    const waiting = await answered(PREVIEWS.ask, "approve")
    expect(dismissed(await store.getItem(db, waiting.id))).toBeUndefined()
    // one he set aside stays on the Archive shelf, its read closing it without a Dismiss
    const aside = await post(decision(PREVIEWS.ship))
    await store.answerItem(db, aside.id, { action: "clear" }, { actor })
    await store.readAnswer(db, (await store.getItem(db, aside.id))!, at)
    expect(dismissed(await store.getItem(db, aside.id))).toBeUndefined()
    // his own earlier Dismiss keeps its time
    const early = await answered(PREVIEWS.budget, "deny")
    const before = new Date(at.getTime() - 60_000)
    await store.dismissItems(db, [early.id], before)
    await store.ackItem(db, early.id, { now: at })
    expect(dismissed(await store.getItem(db, early.id))).toBe(before.toISOString())
  })

  test("Move to Inbox takes an archived item back to open with no answer, and nothing else (PG-654)", async () => {
    const sent: Delivery[] = []
    const deliver = async (delivery: Delivery) => {
      sent.push(delivery)
      return { at: "2026-10-07T12:00:00.000Z", ok: true as const, sessionId: "s1" }
    }
    const aside = await post(decision(PREVIEWS.ship))
    const cleared = await store.answerItem(db, aside.id, { action: "clear" }, { actor, deliver })
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.item.status).toBe("cleared")
    const before = sent.length
    const back = await store.answerItem(
      db,
      aside.id,
      { action: "unarchive", seen: cleared.item.updatedAt },
      { actor, deliver },
    )
    if (!back.ok) throw new Error(back.message)
    expect(back.item).toMatchObject({ answer: null, delivery: null, status: "open" })
    expect(back.item.version).toBe(cleared.item.version + 1)
    // nothing was decided, so nothing is typed into its poster
    expect(sent).toHaveLength(before)
    // answered again, as any open item is
    const approved = await store.answerItem(db, aside.id, { action: "approve" }, { actor })
    expect(approved.ok && approved.item.status).toBe("approved")
    // an item that is not archived is refused: open, answered, or an update
    const update = await post({
      from: "ops",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged: the export fix",
    })
    for (const id of [(await post(decision(PREVIEWS.schema))).id, aside.id, update.id]) {
      expect(await store.answerItem(db, id, { action: "unarchive" }, { actor })).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
    }
    // a draft archives and comes back the same way
    const draft = await post({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
      title: "Ask Merritt",
    })
    const archived = await store.answerItem(db, draft.id, { action: "clear" }, { actor })
    expect(archived.ok && archived.item.status).toBe("cleared")
    const reopened = await store.answerItem(db, draft.id, { action: "unarchive" }, { actor })
    expect(reopened.ok && reopened.item.status).toBe("open")
    // one set aside and sent to Done moves back too, as Done's Move back offers it (#882)
    const done = await post(decision(PREVIEWS.ship))
    await store.answerItem(db, done.id, { action: "clear" }, { actor })
    await store.dismissItems(db, [done.id])
    const fromDone = await store.answerItem(db, done.id, { action: "unarchive" }, { actor })
    expect(fromDone.ok && fromDone.item).toMatchObject({ answer: null, status: "open" })
  })

  describe("Archive, Later, Move back, Done and Dismiss on every state (#882)", () => {
    const typed = () => {
      const sent: Delivery[] = []
      const deliver = async (delivery: Delivery) => {
        sent.push(delivery)
        return { at: "2026-10-07T12:00:00.000Z", ok: true as const, sessionId: "s1" }
      }
      return { deliver, sent }
    }
    const update = () =>
      post({
        from: "ops",
        kind: "update",
        preview: { outcome: "merged" },
        title: "Merged: the fix",
      })
    const listed = async (id: string) => {
      const list = await store.listItems(db)
      return {
        archived: list.archived.some((item) => item.id === id),
        items: list.items.some((item) => item.id === id),
        snoozed: list.snoozed.some((item) => item.id === id),
      }
    }
    const later = new Date(Date.now() + 3_600_000).toISOString()

    test("Archive keeps a waiting decision open and unanswered, types nothing, and lists it as archived alone, out of items and the count", async () => {
      const { deliver, sent } = typed()
      const posted = await post(decision(PREVIEWS.ship))
      const before = (await store.listItems(db)).count
      const archived = await store.answerItem(
        db,
        posted.id,
        { action: "archive" },
        { actor, deliver },
      )
      if (!archived.ok) throw new Error(archived.message)
      expect(archived.item.status).toBe("open")
      expect(archived.item.answer).toMatchObject({ archivedAt: expect.any(String) })
      expect(sent).toHaveLength(0)
      expect(await listed(posted.id)).toEqual({ archived: true, items: false, snoozed: false })
      expect((await store.listItems(db)).count).toBe(before - 1)
      // archived twice is refused
      expect(await store.answerItem(db, posted.id, { action: "archive" }, { actor })).toMatchObject(
        {
          code: "CONFLICT",
          ok: false,
        },
      )
    })

    test("Move back returns an archived item to the list as it was, and Later takes it off Archive until its time", async () => {
      const posted = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, posted.id, { action: "archive" }, { actor })
      const back = await store.answerItem(db, posted.id, { action: "unarchive" }, { actor })
      expect(back.ok && back.item).toMatchObject({ answer: null, status: "open" })
      expect(await listed(posted.id)).toEqual({ archived: false, items: true, snoozed: false })
      await store.answerItem(db, posted.id, { action: "archive" }, { actor })
      const put = await store.scheduleItem(db, posted.id, later)
      if (!put.ok) throw new Error(put.message)
      expect(put.item.answer).toEqual({ snoozedUntil: later })
      expect(await listed(posted.id)).toEqual({ archived: false, items: false, snoozed: true })
      // settled, so no open item sleeps past the other tests' clocks
      expect(await store.settleItem(db, posted.id)).toMatchObject({ ok: true })
    })

    test("an update archives, comes back, and is put off until a time, Later's shelf holding it", async () => {
      const posted = await update()
      const archived = await store.answerItem(db, posted.id, { action: "archive" }, { actor })
      expect(archived.ok).toBe(true)
      expect(await listed(posted.id)).toEqual({ archived: true, items: false, snoozed: false })
      await store.answerItem(db, posted.id, { action: "unarchive" }, { actor })
      expect(await listed(posted.id)).toEqual({ archived: false, items: true, snoozed: false })
      const put = await store.scheduleItem(db, posted.id, later)
      expect(put.ok).toBe(true)
      expect(await listed(posted.id)).toEqual({ archived: false, items: false, snoozed: true })
      // Done wakes it and sends it to Done
      await store.dismissItems(db, [posted.id])
      const done = await store.getItem(db, posted.id)
      expect(done?.answer).toEqual({ dismissedAt: expect.any(String) })
      expect(await listed(posted.id)).toMatchObject({ archived: false, snoozed: false })
    })

    test("Dismiss on a waiting decision, draft or secret sets it aside as clear did, telling its poster so, and sends it to Done marked dismissed", async () => {
      const draft = await post({
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
        title: "Ask Merritt",
      })
      for (const posted of [
        await post(decision(PREVIEWS.ship)),
        draft,
        await post(decision(SECRET)),
      ]) {
        const { deliver, sent } = typed()
        const dismissed = await store.answerItem(
          db,
          posted.id,
          { action: "dismiss" },
          { actor, deliver },
        )
        if (!dismissed.ok) throw new Error(dismissed.message)
        expect(dismissed.item.status).toBe("cleared")
        expect(dismissed.item.answer).toMatchObject({
          choice: "clear",
          dismissed: true,
          dismissedAt: expect.any(String),
        })
        expect(sent).toHaveLength(1)
        expect(payloadOf(sent[0]!.text)).toMatchObject({
          go: false,
          id: posted.id,
          next: "close",
          verb: "set-aside",
        })
        expect(await listed(posted.id)).toMatchObject({ archived: false })
      }
      // an archived one dismissed is set aside the same way
      const archived = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, archived.id, { action: "archive" }, { actor })
      const aside = await store.answerItem(db, archived.id, { action: "dismiss" }, { actor })
      expect(aside.ok && aside.item.status).toBe("cleared")
    })

    test("Dismiss on an answered item or an update marks it dismissed, keeping when it first went to Done, and a second is refused", async () => {
      const posted = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, posted.id, { action: "approve" }, { actor })
      const at = new Date("2026-10-07T12:00:00.000Z")
      await store.dismissItems(db, [posted.id], at)
      const dismissed = await store.answerItem(db, posted.id, { action: "dismiss" }, { actor })
      if (!dismissed.ok) throw new Error(dismissed.message)
      expect(dismissed.item.status).toBe("approved")
      expect(dismissed.item.answer).toMatchObject({
        choice: "approve",
        dismissed: true,
        dismissedAt: at.toISOString(),
      })
      expect(await store.answerItem(db, posted.id, { action: "dismiss" }, { actor })).toMatchObject(
        {
          code: "CONFLICT",
          ok: false,
        },
      )
      const read = await update()
      const gone = await store.answerItem(db, read.id, { action: "dismiss" }, { actor })
      expect(gone.ok && gone.item).toMatchObject({
        answer: { dismissed: true, dismissedAt: expect.any(String) },
        readAt: expect.any(String),
      })
    })

    test("Dismiss tells an answered card's poster dismiss with how to close it, and an update's poster dismiss or, on Done, done; an answered card on Done, and one its poster closed, type nothing", async () => {
      const go = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, go.id, { action: "approve" }, { actor })
      const told = typed()
      const dropped = await store.answerItem(db, go.id, { action: "dismiss" }, { actor, ...told })
      if (!dropped.ok) throw new Error(dropped.message)
      expect(told.sent).toHaveLength(1)
      expect(told.sent[0]!.to).toBe(go.from)
      expect(payloadOf(told.sent[0]!.text)).toMatchObject({
        close: `playground ask ack #i${go.ref} --no-link "<why>"`,
        go: false,
        id: go.id,
        kind: "decision",
        next: "close",
        verb: "dismiss",
      })
      expect(dropped.item.delivery).toMatchObject({ status: "delivered" })

      const denied = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, denied.id, { action: "deny" }, { actor })
      const deniedTold = typed()
      await store.answerItem(db, denied.id, { action: "dismiss" }, { actor, ...deniedTold })
      expect(payloadOf(deniedTold.sent[0]!.text)).toMatchObject({
        close: `playground ask get #i${denied.ref} --ack`,
        verb: "dismiss",
      })

      const closed = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, closed.id, { action: "deny" }, { actor })
      await store.ackItem(db, closed.id)
      const quiet = typed()
      const done = await store.answerItem(db, closed.id, { action: "dismiss" }, { actor, ...quiet })
      expect(done.ok).toBe(true)
      expect(quiet.sent).toHaveLength(0)

      const finished = await post(decision(PREVIEWS.ship))
      await store.answerItem(db, finished.id, { action: "deny" }, { actor })
      const doneQuiet = typed()
      expect(await store.dismissItems(db, [finished.id], new Date(), { actor, ...doneQuiet })).toBe(
        1,
      )
      expect(doneQuiet.sent).toHaveLength(0)

      const progress = await update()
      const doneTold = typed()
      expect(await store.dismissItems(db, [progress.id], new Date(), { actor, ...doneTold })).toBe(
        1,
      )
      expect(doneTold.sent).toHaveLength(1)
      const line = payloadOf(doneTold.sent[0]!.text)
      expect(line).toMatchObject({ go: false, kind: "update", next: "nothing", verb: "done" })
      expect(line).not.toHaveProperty("close")
      // Done already told it, so its Dismiss on Done types nothing again
      const again = typed()
      await store.answerItem(db, progress.id, { action: "dismiss" }, { actor, ...again })
      expect(again.sent).toHaveLength(0)

      const listedUpdate = await update()
      const dismissTold = typed()
      await store.answerItem(db, listedUpdate.id, { action: "dismiss" }, { actor, ...dismissTold })
      expect(payloadOf(dismissTold.sent[0]!.text)).toMatchObject({
        kind: "update",
        next: "nothing",
        verb: "dismiss",
      })
    })
  })

  test("a settle takes no reply its poster closed, and keeps its link (PG-2444)", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    const at = new Date("2026-10-28T03:00:00.000Z")
    await store.recordReply(db, posted.ref, at)
    const closed = await store.ackItem(db, posted.id, {
      link: CHANNEL,
      now: new Date(at.getTime() + 60_000),
    })
    if (!closed.ok) throw new Error(closed.message)
    expect(await store.settleItem(db, posted.id, { note: "Decided another way" })).toMatchObject({
      code: "CONFLICT",
      message: "This item is already answered",
      ok: false,
    })
    const after = await store.getItem(db, posted.id)
    expect(after?.status).toBe("open")
    expect(after?.answer).toEqual(closed.item.answer)
    expect(after?.answer).toMatchObject({ link: CHANNEL })
    const bare = await post(decision(PREVIEWS.schema))
    await store.recordReply(db, bare.ref, at)
    const bareClosed = await store.ackItem(db, bare.id, { now: new Date(at.getTime() + 60_000) })
    if (!bareClosed.ok) throw new Error(bareClosed.message)
    expect(await store.settleItem(db, bare.id, { note: "Decided another way" })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    expect((await store.getItem(db, bare.id))?.answer).toEqual(bareClosed.item.answer)
  })

  test("a replied item from before the clocks stopped leaves the list once its week is up, as an answered one does", async () => {
    const posted = await post(decision(PREVIEWS.ticket))
    const stopped = Date.parse(CLOCKS_STOPPED_AT)
    await store.recordReply(db, posted.ref, new Date(stopped - 60 * 60_000))
    const later = new Date(stopped + 8 * 24 * 60 * 60 * 1000)
    expect((await store.listItems(db, later)).items.map((i) => i.id)).not.toContain(posted.id)
  })

  // Since the clocks stopped, a card moves by a verb alone, so the list's week drops none of these: an approved go its poster has not acked, a card he only commented on, and an update he read; each leaves once its poster closes it or he dismisses it.
  test("an unacked go, a comment-alone card, a read update and one woken from Later since the clocks stopped stay listed 8 days on, until a verb closes each", async () => {
    const stopped = Date.parse(CLOCKS_STOPPED_AT)
    const at = new Date(stopped + 60 * 60_000)
    const delivered = async () => ({ at: at.toISOString(), ok: true as const, sessionId: "s1" })
    const go = await post(decision(PREVIEWS.ship))
    const approved = await store.answerItem(
      db,
      go.id,
      { action: "approve" },
      { actor, deliver: delivered, now: at },
    )
    if (!approved.ok) throw new Error(approved.message)
    const replied = await post(decision(PREVIEWS.ticket))
    await store.recordReply(db, replied.ref, at, "wait for the docs first")
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged a made-up change",
    })
    expect(await store.markRead(db, [update.id], at)).toBe(1)
    // put off with Later and woken: its answer holds the past snoozedUntil, yet it waits on his Done as a read update does
    const woken = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged a made-up change put off",
    })
    expect(await store.markRead(db, [woken.id], at)).toBe(1)
    const put = await store.scheduleItem(
      db,
      woken.id,
      new Date(at.getTime() + 60 * 60_000).toISOString(),
      {
        now: at,
      },
    )
    if (!put.ok) throw new Error(put.message)
    const ids = [go.id, replied.id, update.id, woken.id]
    const later = new Date(stopped + 8 * 24 * 60 * 60 * 1000)
    const listed = (await store.listItems(db, later)).items.map((i) => i.id)
    expect(ids.filter((id) => listed.includes(id))).toEqual(ids)
    const closed = new Date(at.getTime() + 60_000)
    const acked = await store.ackItem(db, go.id, { noLink: "made-up", now: closed })
    if (!acked.ok) throw new Error(acked.message)
    expect(await store.dismissItems(db, [replied.id, update.id, woken.id], closed)).toBe(3)
    const after = (await store.listItems(db, later)).items.map((i) => i.id)
    expect(ids.filter((id) => after.includes(id))).toEqual([])
  })

  // The rest side caps at 200 rows, newest first; a replied item since the clocks stopped waits on its poster's verb, so the cap never pushes it out.
  test("a replied item since the clocks stopped stays in the list once the rest side's 200 rows are full", async () => {
    const posted = await post(decision(PREVIEWS.ticket))
    await store.recordReply(db, posted.ref, new Date(Date.parse(CLOCKS_STOPPED_AT) + 60_000))
    const updates: string[] = []
    for (let i = 0; i < 200; i++) {
      const update = await post({
        from: "builder",
        kind: "update",
        preview: { outcome: "merged" },
        title: `Merged ${i}`,
      })
      updates.push(update.id)
    }
    expect((await store.listItems(db)).items.map((i) => i.id)).toContain(posted.id)
    // read the 200 back, so the store's later tests see no unread pile of ours
    expect(
      await store.markRead(db, updates, new Date(Date.parse(CLOCKS_STOPPED_AT) - 60_000)),
    ).toBe(200)
    expect(await store.dismissItems(db, [posted.id])).toBe(1)
  })

  // An item he opened again from its card after a chat reply: its poster reads one answer, the one that replaced the reply, and is chased for that alone.
  describe("an answer from the card over a chat reply its poster has not closed (PG-1790)", () => {
    const replyTo = async () => {
      const posted = await post({
        from: "dispatcher",
        kind: "draft",
        preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
        title: "Ask Merritt",
      })
      const at = new Date()
      await store.recordReply(db, posted.ref, at)
      const stale = async () =>
        (
          await store.staleItems(db, {
            minutes: 15,
            now: new Date(at.getTime() + 16 * 60_000),
            since: new Date(at.getTime() - 60_000),
          })
        ).find((i) => i.id === posted.id)
      return { posted, stale }
    }

    test("Send replaces the reply: its poster reads Send, and is chased for Send alone", async () => {
      const { posted, stale } = await replyTo()
      const sent = await store.answerItem(db, posted.id, { action: "send" }, { actor })
      if (!sent.ok) throw new Error(sent.message)
      expect(sent.item.status).toBe("sent")
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({ choice: "send" })
      expect((await stale())?.answer).toMatchObject({ choice: "send" })
    })

    test("Schedule replaces the reply: its poster reads no answer, and is chased for none, until he answers", async () => {
      const { posted, stale } = await replyTo()
      // a year out, so a later test listing a week ahead still finds it asleep
      const at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      const scheduled = await store.scheduleItem(db, posted.id, at)
      if (!scheduled.ok) throw new Error(scheduled.message)
      expect(scheduled.item.status).toBe("open")
      expect((await store.getItem(db, posted.id))?.answer).toEqual({ snoozedUntil: at })
      expect(await stale()).toBeUndefined()
    })

    test("a reply its poster closed takes no Schedule", async () => {
      const { posted } = await replyTo()
      await store.ackItem(db, posted.id, { link: CHANNEL })
      const at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      expect(await store.scheduleItem(db, posted.id, at)).toMatchObject({
        code: "CONFLICT",
        message: "Only an open decision or draft, or an update in your list, can be scheduled",
      })
    })
  })

  test("the stale read still chases a replied item until its poster closes it", async () => {
    const posted = await post(decision(PREVIEWS.ship))
    const at = new Date()
    await store.recordReply(db, posted.ref, at)
    const stale = async () =>
      (
        await store.staleItems(db, {
          minutes: 15,
          now: new Date(at.getTime() + 16 * 60_000),
          since: new Date(at.getTime() - 60_000),
        })
      ).map((i) => i.id)
    expect(await stale()).toContain(posted.id)
    await store.ackItem(db, posted.id, { link: "https://github.com/acme/app/pull/270" })
    expect(await stale()).not.toContain(posted.id)
  })

  test("the poster resolves its own alert update; another session, a decision and an unknown id are refused (#658)", async () => {
    const alert = async () => {
      const posted = await post({
        from: "ops",
        kind: "update",
        preview: { outcome: "alert" },
        title: "The Mac is on battery",
      })
      return posted
    }
    const posted = await alert()
    const at = new Date("2026-10-07T12:00:00.000Z")
    const resolved = await store.resolveItem(db, `#i${posted.ref}`, {
      by: "ops",
      note: "Plugged in",
      now: at,
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.item.readAt).toBe(at.toISOString())
    expect(resolved.item.answer).toEqual({
      at: at.toISOString(),
      by: "ops",
      choice: "resolved",
      note: "Plugged in",
    })
    // a resolved alert stays resolved: a second resolve is refused
    expect(await store.resolveItem(db, posted.id, { by: "ops", now: at })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    // another session's resolve is refused, naming who posted it
    const other = await alert()
    expect(await store.resolveItem(db, other.id, { by: "builder" })).toMatchObject({
      code: "CONFLICT",
      message: "Only ops, which posted it, resolves this update",
      ok: false,
    })
    // a decision settles, it does not resolve
    expect(
      await store.resolveItem(db, (await post(decision(PREVIEWS.budget))).id, { by: "ops" }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(await store.resolveItem(db, "#i999999", { by: "ops" })).toMatchObject({
      code: "NOT_FOUND",
      ok: false,
    })
    // the note is one line, and never an archives-style Slack link
    const long = await alert()
    expect(await store.resolveItem(db, long.id, { by: "ops", note: "two\nlines" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    const archived = await alert()
    expect(
      await store.resolveItem(db, archived.id, {
        by: "ops",
        note: "see https://acme.slack.com/archives/C0MADEUP01",
      }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    // nothing here leaves an update unread
    await store.markRead(db, [other.id, long.id, archived.id])
  })

  // PG-1349: a finished progress card and the focus card waited for the owner's Done, since resolve took an alert alone
  test("the poster resolves any update of its own once it has settled, a finished progress card and the focus card included, read and with its note; another session's is refused (PG-1349)", async () => {
    const at = new Date("2026-10-07T12:00:00.000Z")
    const progress = await post({
      from: "worker-made-up",
      kind: "update",
      preview: { outcome: "merged", text: "```\nMade-up job  ██████████  3/3\n```" },
      title: "Made-up job: 3 of 3 steps done",
    })
    const done = await store.resolveItem(db, `#i${progress.ref}`, {
      by: "worker-made-up",
      note: "All 3 steps done",
      now: at,
    })
    expect(done).toMatchObject({
      item: {
        answer: {
          at: at.toISOString(),
          by: "worker-made-up",
          choice: "resolved",
          note: "All 3 steps done",
        },
        readAt: at.toISOString(),
      },
      ok: true,
    })
    const focus = await post({
      from: "ops",
      kind: "update",
      preview: { outcome: "finding" },
      title: "Focus for worker-f ended: 0 runs queued while it stood, 0m0s in all",
    })
    expect(await store.resolveItem(db, focus.id, { by: "worker-made-up" })).toMatchObject({
      code: "CONFLICT",
      message: "Only ops, which posted it, resolves this update",
      ok: false,
    })
    const note = "Everything that came in while focus stood is answered"
    expect(await store.resolveItem(db, focus.id, { by: "ops", note, now: at })).toMatchObject({
      item: { answer: { by: "ops", choice: "resolved", note } },
      ok: true,
    })
  })

  test("ack and settle store where the answer was carried out, and take an https URL alone", async () => {
    const draft = await post({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi", to: "@Merritt" },
      title: "Ask Merritt",
    })
    await store.answerItem(db, draft.id, { action: "send" }, { actor })
    const permalink =
      "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
    for (const bad of [
      "http://app.slack.com/client/T0000000000/C0MADEUP01",
      "https://acme.slack.com/archives/C0MADEUP01/p1700000000000100",
      "not a url",
      "javascript:alert(1)",
    ]) {
      expect(await store.ackItem(db, draft.id, { link: bad })).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
    }
    const acked = await store.ackItem(db, draft.id, { link: permalink })
    expect(acked.ok && acked.item.answer).toMatchObject({ choice: "send", link: permalink })
    expect(acked.ok && acked.item.delivery?.status).toBe("delivered")
    const ticket = await post(decision(PREVIEWS.ticket))
    expect(await store.settleItem(db, ticket.id, { link: "ftp://linear.app/x" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    const settled = await store.settleItem(db, ticket.id, {
      link: "https://linear.app/team/issue/MADECEDAR-1",
    })
    expect(settled.ok && settled.item.answer).toMatchObject({
      choice: "settled",
      link: "https://linear.app/team/issue/MADECEDAR-1",
    })
  })

  test("a link's label is kept beside it, needs the link, and is one line", async () => {
    const ticket = await post(decision(PREVIEWS.ticket))
    await store.answerItem(db, ticket.id, { action: "approve" }, { actor })
    const link = "https://linear.app/acme/issue/MADEDUNE-2186"
    expect(await store.ackItem(db, ticket.id, { label: "Filed MADEDUNE-2186" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    expect(
      await store.ackItem(db, ticket.id, {
        label: "Sent in https://acme.slack.com/archives/C0MADEUP01",
        link: "https://app.slack.com/client/T0000000000/C0MADEUP01",
      }),
    ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(await store.ackItem(db, ticket.id, { label: "two\nlines", link })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    const acked = await store.ackItem(db, ticket.id, { label: " Filed MADEDUNE-2186 ", link })
    expect(acked.ok && acked.item.answer).toMatchObject({ link, linkLabel: "Filed MADEDUNE-2186" })
    const other = await post(decision(PREVIEWS.delete))
    const settled = await store.settleItem(db, other.id, {
      label: "Closed acme/app#12",
      link: "https://github.com/acme/app/pull/12",
    })
    expect(settled.ok && settled.item.answer).toMatchObject({
      choice: "settled",
      linkLabel: "Closed acme/app#12",
    })
  })

  test("a re-ack with a new link and no label drops the old link's label, so the card names the new link", async () => {
    const ticket = await post(decision(PREVIEWS.ticket))
    await store.answerItem(db, ticket.id, { action: "approve" }, { actor })
    await store.ackItem(db, ticket.id, {
      label: "Filed MADEDUNE-2186",
      link: "https://linear.app/acme/issue/MADEDUNE-2186",
    })
    const again = await store.ackItem(db, ticket.id, {
      link: "https://linear.app/acme/issue/MADEDUNE-2187",
    })
    expect(again.ok && again.item.answer).toMatchObject({
      link: "https://linear.app/acme/issue/MADEDUNE-2187",
    })
    expect(again.ok && again.item.answer && "linkLabel" in again.item.answer).toBe(false)
  })

  test("a failed delivery is recorded, and the poster's ack marks it read", async () => {
    const posted = await post({
      from: "dispatcher",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi", to: "@Merritt" },
      title: "Ask Merritt",
    })
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "send", text: "hi there" },
      {
        actor,
        deliver: async () => ({
          code: "NOT_FOUND",
          ok: false,
          reason: "no session named dispatcher",
        }),
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(answered.item.status).toBe("sent")
    expect(answered.item.answer).toMatchObject({ editedText: "hi there" })
    expect(answered.item.delivery).toMatchObject({ code: "NOT_FOUND", status: "failed" })
    const acked = await store.ackItem(db, `#i${posted.ref}`, { link: CHANNEL })
    if (!acked.ok) throw new Error(acked.message)
    expect(acked.item.delivery).toMatchObject({ status: "delivered", via: "cli" })
  })

  const gone = async (delivery: Delivery) => ({
    code: "NOT_FOUND",
    ok: false as const,
    reason: `No live session is named ${delivery.to}.`,
  })

  // the poster "worker-eod" has ended; any other session takes the answer
  const afterPoster = async (delivery: Delivery) =>
    delivery.to === "worker-eod"
      ? gone(delivery)
      : { at: "2026-10-26T06:00:00.000Z", ok: true as const, sessionId: "s1" }

  test("an answer to a poster that has ended goes to the dispatcher, with the item, its kind, the answer and the preview text, and does not read failed", async () => {
    const posted = await post({
      from: "worker-eod",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi Merritt, the fix is on staging.", to: "@Merritt" },
      title: "Tell Merritt",
    })
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "send", text: "hi Merritt, it is live." },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return afterPoster(delivery)
        },
        dispatcher: "dispatcher",
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(sent.map((d) => d.to)).toEqual(["worker-eod", "dispatcher"])
    // the dispatcher gets the poster's line with relay set, and reads the preview with playground ask get
    const relay = sent[1]?.text ?? ""
    expect(payloadOf(relay)).toMatchObject({
      close: `playground ask ack #i${posted.ref} --link <https url>`,
      kind: "draft",
      next: "carry-out",
      ref: `#i${posted.ref}`,
      relay: { for: "worker-eod", why: "poster-ended" },
      text: "hi Merritt, it is live.",
      verb: "send",
    })
    expect(relay).not.toContain("hi Merritt, the fix is on staging.")
    expect(payloadOf(sent[0]?.text ?? "")).not.toHaveProperty("relay")
    expect(answered.item.delivery).toEqual({
      at: "2026-10-26T06:00:00.000Z",
      status: "delivered",
      to: "dispatcher",
      via: "session",
    })
    expect(store.deliveryFailed(answered.item)).toBe(false)
  })

  describe("a card's Reply, his comment alone (ib-7)", () => {
    const capture = () => {
      const sent: Delivery[] = []
      const deliver = async (delivery: Delivery) => {
        sent.push(delivery)
        return afterPoster(delivery)
      }
      return { deliver, sent }
    }
    const reached = async () =>
      ({ at: "2026-10-26T06:00:00.000Z", ok: true, sessionId: "s1" }) as const

    test("types re #iN: <words> into its poster and keeps an open card waiting on the poster, as a chat reply does", async () => {
      const posted = await post({ ...decision(PREVIEWS.delete), from: "ops" })
      const { deliver, sent } = capture()
      const replied = await store.replyItem(
        db,
        posted.id,
        { text: " Split it in two " },
        { actor, deliver, dispatcher: "dispatcher" },
      )
      if (!replied.ok) throw new Error(replied.message)
      expect(sent.map((d) => [d.to, d.text])).toEqual([
        ["ops", `re #i${posted.ref}: Split it in two`],
      ])
      expect(replied.item).toMatchObject({
        answer: { choice: "replied", said: "Split it in two" },
        delivery: null,
        status: "open",
      })
      await store.settleItem(db, posted.id)
    })

    test("on an answered card or an update, types the comment and keeps the card's answer and delivery", async () => {
      const answered = await post({ ...decision(PREVIEWS.delete), from: "ops" })
      await store.answerItem(db, answered.id, { action: "approve" }, { actor, deliver: reached })
      const before = await store.getItem(db, answered.id)
      const update = await post({
        from: "builder",
        kind: "update",
        preview: { outcome: "merged" },
        title: "Merged",
      })
      for (const item of [answered, update]) {
        const { deliver, sent } = capture()
        const replied = await store.replyItem(
          db,
          item.id,
          { text: "Thanks" },
          { actor, deliver, dispatcher: "dispatcher" },
        )
        if (!replied.ok) throw new Error(replied.message)
        expect(sent.map((d) => d.text)).toEqual([`re #i${item.ref}: Thanks`])
      }
      expect(await store.getItem(db, answered.id)).toEqual(before)
      expect((await store.getItem(db, update.id))?.answer).toBeNull()
      await store.dismissItems(db, [answered.id, update.id])
    })

    test("goes to the dispatcher once its poster has ended, and one that reaches no session is refused, recording nothing", async () => {
      const posted = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
      const { deliver, sent } = capture()
      const relayed = await store.replyItem(
        db,
        posted.id,
        { text: "Hold it" },
        { actor, deliver, dispatcher: "dispatcher" },
      )
      expect(relayed.ok).toBe(true)
      expect(sent.map((d) => [d.to, d.text])).toEqual([
        ["worker-eod", `re #i${posted.ref}: Hold it`],
        ["dispatcher", `re #i${posted.ref}: Hold it`],
      ])
      const lone = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
      expect(
        await store.replyItem(db, lone.id, { text: "Hold it" }, { actor, deliver: gone }),
      ).toMatchObject({ code: "UNDELIVERED", ok: false })
      expect((await store.getItem(db, lone.id))?.answer).toBeNull()
      expect(
        await store.replyItem(db, lone.id, { text: "  " }, { actor, deliver: reached }),
      ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      expect(
        await store.replyItem(db, "#i999999", { text: "Hi" }, { actor, deliver: reached }),
      ).toMatchObject({ code: "NOT_FOUND", ok: false })
      await store.settleItem(db, posted.id)
      await store.settleItem(db, lone.id)
    })

    test("its poster's edit after the comment returns the card to waiting on him", async () => {
      const posted = await post({ ...decision(PREVIEWS.delete), from: "ops" })
      await store.replyItem(
        db,
        posted.id,
        { text: "Name the folders" },
        { actor, deliver: reached },
      )
      // a second after the row's stamp, which the comment moved past the post's, so the edit can only stamp the time it was given (#1028, and #1037's nit)
      const commented = await store.getItem(db, posted.id)
      if (!commented) throw new Error("the commented card is gone")
      const later = new Date(Date.parse(commented.updatedAt) + 1000)
      const edited = await store.editItem(
        db,
        posted.id,
        { ...decision(PREVIEWS.delete), from: "ops", title: "Delete these 47 worktrees?" },
        later,
      )
      if (!edited.ok) throw new Error(edited.message)
      expect(edited.item).toMatchObject({ answer: null, status: "open" })
      expect(edited.item.updatedAt).toBe(later.toISOString())
      await store.settleItem(db, posted.id)
    })
  })

  describe("a post and its later writes, stamped by one clock (#1034)", () => {
    const at = new Date("2026-10-26T06:00:00.000Z")
    const plus = (ms: number) => new Date(at.getTime() + ms)
    const postAt = async (now: Date) => {
      const posted = await store.postItem(db, decision(PREVIEWS.delete), undefined, now)
      if (!posted.ok) throw new Error(posted.message)
      return posted.item
    }

    test("a post takes createdAt and updatedAt from its own now", async () => {
      const posted = await postAt(at)
      expect([posted.createdAt, posted.updatedAt]).toEqual([at.toISOString(), at.toISOString()])
      await store.settleItem(db, posted.id)
    })

    test("an edit 999 ms and 1000 ms after its post stores exactly that gap, the one changedAt's threshold reads", async () => {
      for (const ms of [999, 1000]) {
        const posted = await postAt(at)
        const edited = await store.editItem(
          db,
          posted.id,
          { ...decision(PREVIEWS.delete), title: "Ship canary to main tonight?" },
          plus(ms),
        )
        if (!edited.ok) throw new Error(edited.message)
        expect(Date.parse(edited.item.updatedAt) - Date.parse(edited.item.createdAt)).toBe(ms)
        await store.settleItem(db, posted.id)
      }
    })

    test("quietIds holds a post from focus's start on, and none from the millisecond before", async () => {
      const before = await postAt(plus(-1))
      const from = await postAt(at)
      expect(quietIds([before, from], { since: at.toISOString() })).toEqual([from.id])
      await store.dismissItems(db, [before.id, from.id])
    })
  })

  test("an answer to a poster that is live goes to the poster alone", async () => {
    const posted = await post({
      from: "worker-eod",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi", to: "@Merritt" },
      title: "Tell Merritt",
    })
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "send" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: "2026-10-26T06:00:00.000Z", ok: true, sessionId: "s1" }
        },
        dispatcher: "dispatcher",
      },
    )
    expect(answered.ok).toBe(true)
    expect(sent.map((d) => d.to)).toEqual(["worker-eod"])
    expect(payloadOf(sent[0]?.text ?? "")).not.toHaveProperty("relay")
    expect(answered.ok && answered.item.delivery).toMatchObject({ to: "worker-eod" })
  })

  test("a dispatcher that cannot be reached either leaves the answer failed, with Retry", async () => {
    const posted = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      { actor, deliver: gone, dispatcher: "dispatcher" },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(answered.item.delivery).toMatchObject({ code: "NOT_FOUND", status: "failed" })
    expect(store.retryable(answered.item)).toBe(true)
    await store.dismissItems(db, [posted.id])
  })

  test("a NOT_FOUND from a live session is not relayed, and stays failed with Retry", async () => {
    const posted = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return {
            code: "NOT_FOUND",
            ok: false as const,
            reason: `${delivery.to} now names another session. Send it again.`,
          }
        },
        dispatcher: "dispatcher",
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(sent.map((d) => d.to)).toEqual(["worker-eod"])
    expect(store.retryable(answered.item)).toBe(true)
    await store.dismissItems(db, [posted.id])
  })

  test("a poster whose Claude is gone from its pane reaches the dispatcher too", async () => {
    const posted = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return delivery.to === "worker-eod"
            ? {
                code: "NOT_FOUND",
                ok: false as const,
                reason: `${delivery.to}'s Claude is not running in its pane any more.`,
              }
            : { at: "2026-10-26T06:00:00.000Z", ok: true as const, sessionId: "s1" }
        },
        dispatcher: "dispatcher",
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(sent.map((d) => d.to)).toEqual(["worker-eod", "dispatcher"])
    expect(answered.item.delivery).toMatchObject({ status: "delivered" })
  })

  test("a deny to an ended poster reaches the dispatcher as an item to close, not a go to carry out", async () => {
    const posted = await post({ ...decision(PREVIEWS.delete), from: "worker-eod" })
    const sent: Delivery[] = []
    await store.answerItem(
      db,
      posted.id,
      { action: "deny" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return afterPoster(delivery)
        },
        dispatcher: "dispatcher",
      },
    )
    expect(sent.map((d) => d.to)).toEqual(["worker-eod", "dispatcher"])
    expect(payloadOf(sent[1]?.text ?? "")).toMatchObject({
      close: `playground ask get #i${posted.ref} --ack`,
      go: false,
      next: "close",
      relay: { for: "worker-eod", why: "poster-ended" },
      verb: "pick",
    })
  })

  test("a clear reaches its poster as set aside, not denied, and its poster's read closes it as a non-go", async () => {
    const posted = await post(decision(PREVIEWS.ticket))
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "clear" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: "2026-10-07T12:00:00.000Z", ok: true as const, sessionId: "s1" }
        },
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(answered.item.status).toBe("cleared")
    expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
      go: false,
      next: "close",
      verb: "set-aside",
    })
    // a go would wait on bun run ask ack with a link; a clear closes on the poster's read, as a deny does
    const read = await store.readAnswer(db, answered.item, new Date("2026-10-07T12:01:00.000Z"))
    expect(read.answer).toMatchObject({ ackedAt: "2026-10-07T12:01:00.000Z", choice: "clear" })
    expect(await store.ackItem(db, posted.id, { noLink: "nothing landed" })).toMatchObject({
      ok: false,
    })
  })

  test("Retry on an answer that failed for an ended poster reaches the dispatcher", async () => {
    const posted = await post({
      from: "worker-eod",
      kind: "draft",
      preview: { link: CHANNEL, text: "hi Merritt", to: "@Merritt" },
      title: "Tell Merritt",
    })
    const failed = await store.answerItem(
      db,
      posted.id,
      { action: "send" },
      { actor, deliver: gone },
    )
    if (!failed.ok) throw new Error(failed.message)
    expect(failed.item.delivery).toMatchObject({ code: "NOT_FOUND", status: "failed" })
    const sent: Delivery[] = []
    const retried = await store.retryDelivery(db, posted.id, {
      actor,
      deliver: async (delivery) => {
        sent.push(delivery)
        return afterPoster(delivery)
      },
      dispatcher: "dispatcher",
    })
    if (!retried.ok) throw new Error(retried.message)
    expect(sent.map((d) => d.to)).toEqual(["worker-eod", "dispatcher"])
    expect(retried.item.delivery).toMatchObject({ status: "delivered", via: "session" })
  })

  test("deliver.ts still words an ended poster the way the relay reads it", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../../api/hono/src/lib/dashboard/deliver.ts"),
    ).text()
    expect(source).toContain("No live session is named ${to}.")
    expect(source).toContain("Claude is not running in its pane any more.")
  })

  test("an item the dispatcher itself posted is not relayed to itself", async () => {
    const posted = await post({ ...decision(PREVIEWS.delete), from: "dispatcher" })
    const sent: Delivery[] = []
    await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return gone(delivery)
        },
        dispatcher: "dispatcher",
      },
    )
    expect(sent.map((d) => d.to)).toEqual(["dispatcher"])
    await store.dismissItems(db, [posted.id])
  })

  const failing = async () => ({
    code: "SESSIONS_FAILED",
    ok: false as const,
    reason: "cmux sessions failed: no answer from cmux",
  })

  test("an answer that failed to send stays in the list and its count past a week, until he dismisses it", async () => {
    const posted = await post(decision(PREVIEWS.delete))
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      { actor, deliver: failing },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(answered.item.status).toBe("approved")
    expect(answered.item.delivery).toMatchObject({ code: "SESSIONS_FAILED", status: "failed" })
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    const list = await store.listItems(db, later)
    expect(list.items.map((i) => i.id)).toContain(posted.id)
    expect(list.count).toBe(store.inboxCount(list.items))
    expect(list.items.filter(store.deliveryFailed).map((i) => i.id)).toEqual([posted.id])
    expect(await store.dismissItems(db, [posted.id])).toBe(1)
    expect((await store.listItems(db, later)).items.map((i) => i.id)).not.toContain(posted.id)
  })

  test("a set-aside item stays in the list past a week, for the Archive shelf, and never counts", async () => {
    const posted = await post(decision(PREVIEWS.ship))
    const delivered = async () => ({
      at: new Date().toISOString(),
      ok: true as const,
      sessionId: "s1",
    })
    const cleared = await store.answerItem(
      db,
      posted.id,
      { action: "clear" },
      { actor, deliver: delivered },
    )
    if (!cleared.ok) throw new Error(cleared.message)
    await store.readAnswer(db, cleared.item)
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    const list = await store.listItems(db, later)
    expect(list.items.filter((i) => i.id === posted.id)).toHaveLength(1)
    expect(list.snoozed.map((i) => i.id)).not.toContain(posted.id)
    expect(list.count).toBe(store.inboxCount(list.items, later))
    // dismissed, it goes to Done, which keeps a week as every settled item does
    expect(await store.dismissItems(db, [posted.id])).toBe(1)
    expect((await store.listItems(db, later)).items.map((i) => i.id)).not.toContain(posted.id)
  })

  test("Retry types the answer again and records the new result, once however often it is clicked", async () => {
    const posted = await post(decision(SLACK))
    await store.answerItem(db, posted.id, { action: "approve" }, { actor, deliver: failing })
    const again = await store.retryDelivery(db, posted.id, { actor, deliver: failing })
    expect(again.ok && again.item.delivery).toMatchObject({
      code: "SESSIONS_FAILED",
      status: "failed",
    })
    const sent: Delivery[] = []
    const deliver = async (delivery: Delivery) => {
      sent.push(delivery)
      return { at: "2026-10-12T07:00:00.000Z", ok: true as const, sessionId: "s1" }
    }
    const [first, second] = await Promise.all([
      store.retryDelivery(db, posted.id, { actor, deliver }),
      store.retryDelivery(db, posted.id, { actor, deliver }),
    ])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect(sent).toHaveLength(1)
    expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
      go: true,
      next: "carry-out",
      verb: "pick",
    })
    expect(sent[0]?.to).toBe("ops")
    const item = await store.getItem(db, posted.id)
    expect(item?.delivery).toMatchObject({ status: "delivered", via: "session" })
    expect(item && store.deliveryFailed(item)).toBe(false)
    expect(await store.retryDelivery(db, posted.id, { actor, deliver })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
  })

  // An answer Claude Code holds (typed while its poster compacts) reads queued, and is read again under the same id until it reads delivered, or lost, which offers Retry
  test("an answer Claude Code holds reads queued, then delivered once a later read finds it arrived", async () => {
    const posted = await post(decision(SLACK))
    const sent: Delivery[] = []
    const answers = [
      { code: "QUEUED", ok: false as const, reason: "ops holds the message" },
      { code: "QUEUED", ok: false as const, reason: "ops holds the message" },
      { at: "2026-10-12T07:00:00.000Z", ok: true as const, sessionId: "s1" },
    ]
    const deliver = async (delivery: Delivery) => {
      sent.push(delivery)
      return answers.shift() ?? answers.at(-1)!
    }
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      { actor, deliver, wait: async () => {} },
    )
    expect(answered.ok && answered.item.delivery).toMatchObject({ status: "queued", to: "ops" })
    for (
      let i = 0;
      i < 50 && (await store.getItem(db, posted.id))?.delivery?.status === "queued";
      i++
    )
      await Bun.sleep(20)
    expect((await store.getItem(db, posted.id))?.delivery).toMatchObject({
      status: "delivered",
      via: "session",
    })
    expect(new Set(sent.map((d) => d.id)).size).toBe(1)
    expect(sent[0]?.id).toBeString()
    // each later read carries when it was first held, so it holds across an API restart too
    const held = answered.ok ? answered.item.delivery : null
    const at = held?.status === "queued" ? held.at : "not queued"
    expect(sent.slice(1).map((d) => d.queuedAt ?? "none")).toEqual([at, at])
  })

  // An API restart ends the follow-up, so a card still queued past STUCK_QUEUED_MS offers Retry, which reads it again under its own id and types nothing while it is held
  test("an answer stuck queued offers Retry past the bound, which reads it again under its own id", async () => {
    expect(store.STUCK_QUEUED_MS).toBe(QUEUED_MS + 60_000)
    const posted = await post(decision(SLACK))
    const sent: Delivery[] = []
    const answers = [
      { code: "QUEUED", ok: false as const, reason: "ops holds the message" },
      { at: "2026-10-12T07:00:00.000Z", ok: true as const, sessionId: "s1" },
    ]
    const deliver = async (delivery: Delivery) => {
      sent.push(delivery)
      return answers.shift()!
    }
    const at = new Date("2026-10-12T06:00:00.000Z")
    const restarted = () => new Promise<void>(() => {})
    await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      { actor, deliver, now: at, wait: restarted },
    )
    const queued = await store.getItem(db, posted.id)
    expect(queued?.delivery).toMatchObject({ status: "queued" })
    const early = new Date(at.getTime() + store.STUCK_QUEUED_MS - 1)
    expect(queued && store.retryable(queued, early)).toBe(false)
    expect(await store.retryDelivery(db, posted.id, { actor, deliver, now: early })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    const stuck = new Date(at.getTime() + store.STUCK_QUEUED_MS)
    expect(queued && store.retryable(queued, stuck)).toBe(true)
    const retried = await store.retryDelivery(db, posted.id, { actor, deliver, now: stuck })
    expect(retried.ok && retried.item.delivery).toMatchObject({ status: "delivered" })
    expect(sent[1]).toMatchObject({ id: sent[0]?.id, queuedAt: at.toISOString(), to: "ops" })
  })

  test("an answer lost from the screen and the transcript fails as LOST, which Retry follows", async () => {
    const posted = await post(decision(SLACK))
    const answers = [
      { code: "QUEUED", ok: false as const, reason: "ops holds the message" },
      { code: "LOST", ok: false as const, reason: "Retry sends it again." },
    ]
    const deliver = async () => answers.shift()!
    await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      { actor, deliver, wait: async () => {} },
    )
    // follow() records LOST in its own write after deliver returns, so the item is read again until that write lands, for 2s at most
    let item = await store.getItem(db, posted.id)
    for (let i = 0; i < 200 && item?.delivery?.status === "queued"; i++) {
      await Bun.sleep(10)
      item = await store.getItem(db, posted.id)
    }
    expect(item?.delivery).toMatchObject({ code: "LOST", status: "failed" })
    expect(item && store.retryable(item)).toBe(true)
  })

  test("the stale read lists an answer its poster has not acked after the minutes given, not before, and not once acked", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    const at = new Date()
    await store.answerItem(db, posted.id, { action: "approve" }, { actor, now: at })
    const since = new Date(at.getTime() - 60_000)
    const stale = async (minutesLater: number) =>
      (
        await store.staleItems(db, {
          minutes: 15,
          now: new Date(at.getTime() + minutesLater * 60_000),
          since,
        })
      ).map((i) => i.id)
    expect(await stale(14)).not.toContain(posted.id)
    expect(await stale(16)).toContain(posted.id)
    // an answer before --since is left out, so answers acked before acks were stamped never show
    expect(
      (
        await store.staleItems(db, {
          minutes: 15,
          now: new Date(at.getTime() + 16 * 60_000),
          since: new Date(at.getTime() + 1),
        })
      ).map((i) => i.id),
    ).not.toContain(posted.id)
    await store.ackItem(db, posted.id, { noLink: "A budget has no page" })
    expect(await stale(16)).not.toContain(posted.id)
  })

  test("the stale read keeps an answer typed into its session until the poster acks it, and drops a failed one he dismissed", async () => {
    const typed = await post(decision(PREVIEWS.ship))
    const failed = await post(decision(PREVIEWS.ticket))
    const at = new Date()
    await store.answerItem(
      db,
      typed.id,
      { action: "approve" },
      {
        actor,
        deliver: async () => ({ at: at.toISOString(), ok: true, sessionId: "s1" }),
        now: at,
      },
    )
    await store.answerItem(
      db,
      failed.id,
      { action: "approve" },
      { actor, deliver: failing, now: at },
    )
    const stale = async () =>
      (
        await store.staleItems(db, {
          minutes: 15,
          now: new Date(at.getTime() + 16 * 60_000),
          since: new Date(at.getTime() - 60_000),
        })
      ).map((i) => i.id)
    expect(await stale()).toEqual(expect.arrayContaining([typed.id, failed.id]))
    await store.ackItem(db, typed.id, { link: "https://github.com/acme/app/pull/270" })
    expect((await store.getItem(db, typed.id))?.delivery).toMatchObject({ via: "session" })
    expect(await stale()).not.toContain(typed.id)
    // he dismissed it from its failed state, so nobody is chased to carry it out, and Retry is refused
    await store.dismissItems(db, [failed.id])
    expect(await stale()).not.toContain(failed.id)
    expect(
      await store.retryDelivery(db, failed.id, {
        actor,
        deliver: async () => ({ at: at.toISOString(), ok: true, sessionId: "s1" }),
      }),
    ).toMatchObject({ code: "CONFLICT", ok: false })
  })

  test("Retry is refused once typing may have begun, since the answer may already be in the session", async () => {
    for (const code of ["INTERRUPTED", "ERROR"]) {
      const posted = await post(decision(PREVIEWS.budget))
      await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        { actor, deliver: async () => ({ code, ok: false, reason: "cut off" }) },
      )
      const item = await store.getItem(db, posted.id)
      expect(item && store.retryable(item), code).toBe(false)
      const sent: Delivery[] = []
      const retried = await store.retryDelivery(db, posted.id, {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: "x", ok: true, sessionId: "s1" }
        },
      })
      expect(retried, code).toMatchObject({ code: "CONFLICT", ok: false })
      expect(sent).toHaveLength(0)
      await store.dismissItems(db, [posted.id])
    }
  })

  test("an ack after the answer was typed into its session stamps it, which keeps the first time", async () => {
    const posted = await post(decision(PREVIEWS.ship))
    await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: async () => ({ at: "2026-10-12T07:00:00.000Z", ok: true, sessionId: "s1" }),
      },
    )
    const link = "https://github.com/acme/app/pull/270"
    const first = await store.ackItem(db, posted.id, {
      link,
      now: new Date("2026-10-12T07:01:00Z"),
    })
    const second = await store.ackItem(db, posted.id, {
      link,
      now: new Date("2026-10-12T07:09:00Z"),
    })
    expect(first.ok && first.item.answer).toMatchObject({ ackedAt: "2026-10-12T07:01:00.000Z" })
    expect(second.ok && second.item.answer).toMatchObject({ ackedAt: "2026-10-12T07:01:00.000Z" })
    expect(second.ok && second.item.delivery).toMatchObject({ via: "session" })
  })

  test("a go closes only with where it landed or why there is none; reading it does not close it, while reading a deny does", async () => {
    // any link leads the same way, GitHub, Slack or Linear, not Slack alone
    const go = await post(decision(PREVIEWS.budget))
    const no = await post(decision(PREVIEWS.delete))
    const at = new Date()
    await store.answerItem(db, go.id, { action: "approve" }, { actor, now: at })
    await store.answerItem(db, no.id, { action: "deny" }, { actor, now: at })
    const stale = async () =>
      (
        await store.staleItems(db, {
          minutes: 0,
          now: new Date(at.getTime() + 1000),
          since: new Date(at.getTime() - 1000),
        })
      ).map((i) => i.id)
    const read = await store.readAnswer(db, (await store.getItem(db, go.id))!)
    expect(read.delivery).toMatchObject({ status: "delivered", via: "cli" })
    await store.readAnswer(db, (await store.getItem(db, no.id))!)
    expect(await stale()).toContain(go.id)
    expect(await stale()).not.toContain(no.id)
    expect(await store.ackItem(db, go.id)).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    expect(await store.ackItem(db, go.id, { link: CHANNEL, noLink: "both" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    expect(await store.ackItem(db, go.id, { noLink: "a\nb" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    // --no-link fits a go alone, and only one with no link recorded
    expect(await store.ackItem(db, no.id, { noLink: "x" })).toMatchObject({
      code: "VALIDATION_ERROR",
      ok: false,
    })
    const closed = await store.ackItem(db, go.id, { noLink: "A budget has no page" })
    expect(closed.ok && closed.item.answer).toMatchObject({ noLink: "A budget has no page" })
    expect(closed.ok && closed.item.answer && "ackedAt" in closed.item.answer).toBe(true)
    expect(await stale()).not.toContain(go.id)
    const linked = await post(decision(PREVIEWS.ship))
    await store.answerItem(db, linked.id, { action: "approve" }, { actor, now: at })
    await store.ackItem(db, linked.id, { link: "https://github.com/acme/app/pull/270" })
    expect(await store.ackItem(db, linked.id, { noLink: "x" })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    // and the other order: a go closed with no link takes no link after
    expect(await store.ackItem(db, go.id, { link: CHANNEL })).toMatchObject({
      code: "CONFLICT",
      ok: false,
    })
    expect(await store.ackItem(db, go.id, { noLink: "" })).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("not empty"),
    })
  })

  test("the stale read lists an answer never read from before acks were stamped, but not one read or delivered then", async () => {
    const before = new Date(store.ACKS_STAMPED_FROM.getTime() - 60 * 60_000)
    const unread = await post(decision(PREVIEWS.budget))
    const read = await post(decision(PREVIEWS.budget))
    await store.answerItem(db, unread.id, { action: "approve" }, { actor, now: before })
    await store.answerItem(db, read.id, { action: "approve" }, { actor, now: before })
    await store.readAnswer(db, (await store.getItem(db, read.id))!, before)
    const listed = (
      await store.staleItems(db, {
        minutes: 15,
        since: new Date(before.getTime() - 60_000),
      })
    ).map((i) => i.id)
    expect(listed).toContain(unread.id)
    expect(listed).not.toContain(read.id)
    await store.ackItem(db, unread.id, { noLink: "A budget has no page" })
  })

  test("a reply reads like a go: reading it does not close it, a plain ack does", async () => {
    // his `re #iN` takes the item off his hands, and it waits on its poster closing it (the sweep keeps chasing)
    const replied = await post(decision(PREVIEWS.delete))
    const at = new Date()
    await store.recordReply(db, replied.ref, at)
    const stale = async () =>
      (
        await store.staleItems(db, {
          minutes: 0,
          now: new Date(at.getTime() + 1000),
          since: new Date(at.getTime() - 1000),
        })
      ).map((i) => i.id)
    const read = await store.readAnswer(db, (await store.getItem(db, replied.id))!)
    expect(read.delivery).toMatchObject({ status: "delivered", via: "cli" })
    expect(await stale()).toContain(replied.id)
    const closed = await store.ackItem(db, replied.id)
    expect(closed.ok && closed.item.answer).toMatchObject({ ackedAt: expect.any(String) })
    expect(await stale()).not.toContain(replied.id)
  })

  test("an open item has nothing to ack", async () => {
    const posted = await post(decision(PREVIEWS.budget))
    expect(await store.ackItem(db, posted.id)).toMatchObject({ code: "CONFLICT", ok: false })
  })

  test("an update starts unread, and reading the ones named takes them off the count, never another", async () => {
    const update = (title: string) =>
      post({ from: "builder", kind: "update", preview: { outcome: "merged" }, title })
    const one = await update("Merged: one")
    const two = await update("Merged: two")
    const three = await update("Merged: three")
    expect(one.readAt).toBeNull()
    expect(await store.markRead(db, [one.id])).toBe(1)
    expect(await store.markRead(db, [one.id])).toBe(0)
    const list = await store.listItems(db)
    const unread = list.items
      // its own three alone: an unread update stays listed at any age, so another test's can show here too
      .filter((i) => [one.id, two.id, three.id].includes(i.id) && i.readAt === null)
      .map((i) => i.id)
    expect(unread).toEqual([three.id, two.id])
    // only the updates named are marked, so one that arrived since stays unread
    const later = await update("Merged: after the screen was read")
    expect(await store.markRead(db, unread)).toBe(2)
    expect(await store.markRead(db, [])).toBe(0)
    expect((await store.getItem(db, three.id))?.readAt).not.toBeNull()
    expect((await store.getItem(db, later.id))?.readAt).toBeNull()
    await store.markRead(db, [later.id])
  })

  test("an open decision marked read stays open and answerable, only seen", async () => {
    const ask = await post(decision(SLACK))
    expect(await store.markRead(db, [ask.id])).toBe(1)
    const read = await store.getItem(db, ask.id)
    expect(read?.readAt).not.toBeNull()
    expect(read?.status).toBe("open")
    expect(read?.answer).toBeNull()
    expect((await store.listItems(db)).items.map((i) => i.id)).toContain(ask.id)
  })

  test("an update takes no answer, which is a bad request rather than a conflict", async () => {
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "alert" },
      title: "Alert: x",
    })
    const answered = await store.answerItem(db, update.id, { action: "approve" }, { actor })
    expect(answered).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
    await store.markRead(db, [update.id])
  })

  test("no pile of unread updates pushes an open decision out of the list or its count", async () => {
    const open = await post(decision(PREVIEWS.schema))
    const pile = []
    for (let i = 0; i < 205; i++) {
      pile.push(
        await post({
          from: "builder",
          kind: "update",
          preview: { outcome: "finding" },
          title: `Finding ${i}`,
        }),
      )
    }
    const list = await store.listItems(db)
    expect(list.items.map((i) => i.id)).toContain(open.id)
    expect(list.items[0]?.status).toBe("open")
    await store.markRead(db, pile.map((i) => i.id).slice(0, 200))
    await store.markRead(db, pile.map((i) => i.id).slice(200))
  }, 60_000)

  test("the list counts what needs him and keeps answered items a week, but for each card that waits on a verb since the clocks stopped", async () => {
    const list = await store.listItems(db)
    expect(list.count).toBe(store.inboxCount(list.items))
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    const old = await store.listItems(db, later)
    const stopped = Date.parse(CLOCKS_STOPPED_AT)
    // since the clocks stopped, an answer its poster has not closed and an update he read and has not dismissed stay at any age
    const waitsOnVerb = (i: InboxItem) => {
      const answer = i.answer as { ackedAt?: string; at?: string; dismissedAt?: string } | null
      if (i.kind === "update")
        return answer === null && i.readAt !== null && Date.parse(i.readAt) >= stopped
      return (
        !!answer?.at && Date.parse(answer.at) >= stopped && !answer.ackedAt && !answer.dismissedAt
      )
    }
    expect(
      old.items.every(
        (i) =>
          i.status === "open" ||
          // a set-aside item stays, however old, for the Archive shelf
          i.status === "cleared" ||
          (i.kind === "update" && i.readAt === null) ||
          store.deliveryFailed(i) ||
          waitsOnVerb(i),
      ),
    ).toBe(true)
  })

  test("Schedule pushes an open decision out of the list and the count until its time, then back", async () => {
    const posted = await post(decision(PREVIEWS.ship))
    const now = new Date("2026-10-07T11:00:00.000Z")
    const at = "2026-10-08T09:00:00.000Z"
    const base = await store.listItems(db, now)
    const scheduled = await store.scheduleItem(db, posted.id, at, { now })
    if (!scheduled.ok) throw new Error(scheduled.message)
    expect(scheduled.item.status).toBe("open")
    expect(store.snoozedUntil(scheduled.item, now)).toBe(at)
    expect(store.snoozedUntil(scheduled.item, new Date(at))).toBeNull()
    const held = await store.listItems(db, now)
    expect(held.items.map((i) => i.id)).not.toContain(posted.id)
    expect(held.count).toBe(base.count - 1)
    // asleep, it comes apart from items, for the Later shelf alone, so no reader of items takes it as waiting
    expect(held.snoozed.map((i) => i.id)).toContain(posted.id)
    const awake = await store.listItems(db, new Date("2026-10-08T09:00:00.000Z"))
    expect(awake.items.map((i) => i.id)).toContain(posted.id)
    expect(awake.snoozed.map((i) => i.id)).not.toContain(posted.id)
    expect(awake.count).toBe(base.count)
    // a second schedule moves the time
    const moved = await store.scheduleItem(db, posted.id, "2026-10-09T09:00:00.000Z", { now })
    if (!moved.ok) throw new Error(moved.message)
    expect(store.snoozedUntil(moved.item, now)).toBe("2026-10-09T09:00:00.000Z")
  })

  test("Schedule refuses an update already done, an answered item and a time that has passed", async () => {
    const at = "2026-10-08T09:00:00.000Z"
    const update = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged",
    })
    await store.dismissItems(db, [update.id])
    expect((await store.scheduleItem(db, update.id, at)).ok).toBe(false)
    const posted = await post(decision(PREVIEWS.ask))
    const answered = await store.answerItem(db, posted.id, { action: "approve" }, { actor })
    if (!answered.ok) throw new Error(answered.message)
    expect((await store.scheduleItem(db, answered.item.id, at)).ok).toBe(false)
    const open = await post(decision(PREVIEWS.ask))
    const late = await store.scheduleItem(db, open.id, "2026-10-07T10:00:00.000Z")
    expect(late.ok).toBe(false)
    expect(await store.scheduleItem(db, "no-such-id", at)).toMatchObject({ code: "NOT_FOUND" })
  })

  test("an answer wakes a scheduled item and carries it out as usual", async () => {
    const posted = await post(decision(PREVIEWS.ship))
    await store.scheduleItem(db, posted.id, "2026-10-08T09:00:00.000Z", {
      now: new Date("2026-10-07T11:00:00.000Z"),
    })
    const sent: Delivery[] = []
    const answered = await store.answerItem(
      db,
      posted.id,
      { action: "approve" },
      {
        actor,
        deliver: (d) => (
          sent.push(d),
          Promise.resolve({ at: "2026-10-07T11:05:00Z", ok: true, sessionId: "s1" })
        ),
      },
    )
    if (!answered.ok) throw new Error(answered.message)
    expect(answered.item.answer).toMatchObject({ choice: "approve" })
    expect(store.snoozedUntil(answered.item, new Date("2026-10-07T11:00:00.000Z"))).toBeNull()
    expect(sent).toHaveLength(1)
  })

  test("a chat reply takes a scheduled item off the schedule, and the poster's ack refuses one with no answer", async () => {
    const posted = await post(decision(PREVIEWS.ask))
    await store.scheduleItem(db, posted.id, "2026-10-08T09:00:00.000Z", {
      now: new Date("2026-10-07T11:00:00.000Z"),
    })
    const replied = await store.recordReply(db, posted.ref)
    expect(replied?.answer).toMatchObject({ choice: "replied" })
    const acked = await store.ackItem(db, posted.id, {
      link: "https://github.com/acme/app/pull/270",
    })
    expect(acked.ok).toBe(true)
    const sleeping = await post(decision(PREVIEWS.ask))
    const scheduled = await store.scheduleItem(db, sleeping.id, "2026-10-08T09:00:00.000Z", {
      now: new Date("2026-10-07T11:00:00.000Z"),
    })
    expect(scheduled.ok).toBe(true)
    expect(
      await store.ackItem(db, sleeping.id, { link: "https://github.com/acme/app/pull/271" }),
    ).toMatchObject({ code: "CONFLICT" })
  })

  test("the sweep skips a scheduled item until its time brings it back", async () => {
    const posted = await post(decision(PREVIEWS.ask))
    const now = new Date("2026-10-07T11:00:00.000Z")
    await store.scheduleItem(db, posted.id, "2026-10-08T09:00:00.000Z", { now })
    expect(
      await store.staleItems(db, {
        minutes: 15,
        now,
        since: new Date("2026-10-07T10:00:00.000Z"),
      }),
    ).toEqual([])
  })

  describe("a secret ask's Submit (PG-59)", () => {
    const VALUE = `made-up-secret-${crypto.randomUUID()}`

    // every row of every table in the database, as text, so a test can say the value is in none
    const everyRow = async (): Promise<string> => {
      const reader = new SQL(url, { max: 1 })
      try {
        const tables: { tablename: string }[] =
          await reader`select tablename from pg_tables where schemaname = 'public'`
        const rows: string[] = []
        for (const { tablename } of tables) {
          const dumped: { row: string }[] = await reader.unsafe(
            `select t::text as row from "${tablename}" t`,
          )
          rows.push(...dumped.map((r) => r.row))
        }
        return rows.join("\n")
      } finally {
        await reader.close()
      }
    }

    // what the stubbed sink was handed: its argv and its stdin, per call
    const stub = (exitCodes: (number | null)[] = []) => {
      const calls: { argv: string[]; stdin: string }[] = []
      const run = async (argv: string[], stdin: string) => {
        calls.push({ argv, stdin })
        return exitCodes[calls.length - 1] ?? 0
      }
      return { calls, run }
    }

    test("hands the value to the sink on stdin once an environment, and keeps only when and each exit status", async () => {
      const posted = await post({ ...decision(SECRET), from: "dispatcher" })
      const sink = stub([0, 1])
      const sent: Delivery[] = []
      const logged: string[] = []
      const console_ = { error: console.error, log: console.log, warn: console.warn }
      for (const name of ["error", "log", "warn"] as const)
        console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
      const at = new Date("2026-10-31T01:00:00.000Z")
      let provided: Awaited<ReturnType<typeof store.provideSecret>>
      try {
        provided = await store.provideSecret(
          db,
          posted.id,
          { seen: posted.updatedAt, value: VALUE },
          {
            actor,
            deliver: async (delivery) => {
              sent.push(delivery)
              return { at: at.toISOString(), ok: true, sessionId: "s1" }
            },
            now: at,
            run: sink.run,
          },
        )
      } finally {
        Object.assign(console, console_)
      }
      expect(provided.ok).toBe(true)
      expect(sink.calls.map((call) => call.stdin)).toEqual([VALUE, VALUE])
      expect(sink.calls.map((call) => call.argv[5])).toEqual(["production", "preview"])
      for (const call of sink.calls) expect(call.argv.join(" ")).not.toContain(VALUE)
      if (!provided.ok) return
      expect(provided.item.status).toBe("provided")
      expect(provided.item.answer).toEqual({
        at: at.toISOString(),
        choice: "provided",
        results: [
          { environment: "production", exitCode: 0 },
          { environment: "preview", exitCode: 1 },
        ],
      })
      // the poster is told when and each status, and never the value
      expect(sent).toHaveLength(1)
      expect(sent[0]?.to).toBe("dispatcher")
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        next: "close",
        results: [
          { environment: "production", exitCode: 0 },
          { environment: "preview", exitCode: 1 },
        ],
        verb: "submit",
      })
      expect(sent[0]?.text).not.toContain(VALUE)
      expect(JSON.stringify(provided.item)).not.toContain(VALUE)
      expect(logged.join("\n")).not.toContain(VALUE)
      expect(await everyRow()).not.toContain(VALUE)
      expect(await everyRow()).toContain(posted.id)
      // the poster's read closes it, as a deny's read does
      const read = await store.readAnswer(db, provided.item)
      expect(read.answer).toMatchObject({ ackedAt: expect.any(String), choice: "provided" })
    })

    test("a keychain sink hands the Yard token to the Keychain writer on stdin, and keeps only saved", async () => {
      const posted = await post({
        ...decision({
          key: "YARD_TOKEN",
          sink: { item: "yard", type: "keychain" },
          type: "secret",
        }),
        from: "dispatcher",
      })
      const token = `yard_${VALUE}`
      const sink = stub()
      const security: { argv: string[]; input?: string }[] = []
      const writer = keychain(async (argv, input) => {
        security.push({ argv, input })
        return { code: 0, stderr: "", stdout: "" }
      }, "owner")
      const sent: Delivery[] = []
      const logged: string[] = []
      const console_ = { error: console.error, log: console.log, warn: console.warn }
      for (const name of ["error", "log", "warn"] as const)
        console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
      let provided: Awaited<ReturnType<typeof store.provideSecret>>
      try {
        provided = await store.provideSecret(
          db,
          posted.id,
          { value: token },
          {
            actor,
            deliver: async (delivery) => {
              sent.push(delivery)
              return { at: new Date().toISOString(), ok: true, sessionId: "s1" }
            },
            run: sink.run,
            keychain: async (item, value) => {
              expect(item).toBe("yard")
              await writer.write(value)
            },
          },
        )
      } finally {
        Object.assign(console, console_)
      }
      expect(sink.calls).toHaveLength(0)
      expect(security).toHaveLength(1)
      expect(security[0]?.argv).toEqual(["security", "-i"])
      expect(security[0]?.input).toContain(`-w "${token}"`)
      expect(provided.ok && provided.item.answer).toMatchObject({
        choice: "provided",
        results: [{ environment: "Keychain", exitCode: 0, line: "saved" }],
      })
      expect(payloadOf(sent[0]?.text ?? "")?.results).toEqual([
        { environment: "Keychain", exitCode: 0, line: "saved" },
      ])
      for (const kept of [
        JSON.stringify(provided),
        JSON.stringify(sent),
        logged.join("\n"),
        await everyRow(),
      ])
        expect(kept).not.toContain(VALUE)
    })

    test("a saved secret whose telling failed keeps its saved result, and its Retry tells the poster again without running the sink (PG-880)", async () => {
      const posted = await post({
        ...decision({
          key: "YARD_TOKEN",
          sink: { item: "yard", type: "keychain" },
          type: "secret",
        }),
        from: "dispatcher",
      })
      const saves: string[] = []
      const keychainSink = async (_item: string, value: string) => void saves.push(value)
      const sink = stub()
      const provided = await store.provideSecret(
        db,
        posted.id,
        { value: `yard_${VALUE}` },
        {
          actor,
          deliver: async () => ({
            code: "SESSIONS_FAILED",
            ok: false,
            reason:
              "The sessions read was cut short (a herdr server or pane did not answer whole), so dispatcher was not found; nothing was typed.",
          }),
          keychain: keychainSink,
          run: sink.run,
        },
      )
      expect(provided.ok && provided.item.delivery).toMatchObject({
        code: "SESSIONS_FAILED",
        status: "failed",
      })
      const saved = provided.ok ? provided.item.answer : null
      expect(saved).toMatchObject({
        results: [{ environment: "Keychain", exitCode: 0, line: "saved" }],
      })
      const sent: Delivery[] = []
      const retried = await store.retryDelivery(db, posted.id, {
        actor,
        deliver: async (delivery) => {
          sent.push(delivery)
          return { at: new Date().toISOString(), ok: true, sessionId: "s1" }
        },
      })
      expect(saves).toEqual([`yard_${VALUE}`])
      expect(sink.calls).toHaveLength(0)
      expect(sent).toHaveLength(1)
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        results: [{ environment: "Keychain", exitCode: 0, line: "saved" }],
        verb: "submit",
      })
      expect(sent[0]?.text).not.toContain(VALUE)
      expect(retried.ok && retried.item.answer).toEqual(saved)
      expect(retried.ok && retried.item.delivery).toMatchObject({ status: "delivered" })
    })

    test("a keychain save that fails keeps the refusal's first line, with the value cut out", async () => {
      const posted = await post(
        decision({ key: "YARD_TOKEN", sink: { item: "yard", type: "keychain" }, type: "secret" }),
      )
      const refused = await store.provideSecret(
        db,
        posted.id,
        { value: `yard_${VALUE}` },
        {
          actor,
          run: stub().run,
          keychain: async (_item, value) => {
            throw new Error(`the Keychain refused it: no item for ${value}\nsecond line`)
          },
        },
      )
      expect(refused.ok && refused.item.answer).toMatchObject({
        results: [
          { environment: "Keychain", exitCode: 1, line: "the Keychain refused it: no item for …" },
        ],
      })
      expect(JSON.stringify(refused)).not.toContain(VALUE)
      expect(await everyRow()).not.toContain(VALUE)
    })

    test("a keychain paste off the item's shape is refused before the claim, so the card stays open", async () => {
      const posted = await post(
        decision({ key: "YARD_TOKEN", sink: { item: "yard", type: "keychain" }, type: "secret" }),
      )
      let saved = 0
      const refused = await store.provideSecret(
        db,
        posted.id,
        { value: VALUE },
        { actor, keychain: async () => void saved++, run: stub().run },
      )
      expect(refused).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "a Yard token starts yard_",
        ok: false,
      })
      expect(saved).toBe(0)
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
      expect(JSON.stringify(refused)).not.toContain(VALUE)
    })

    test("runs once: a second Submit, or one on words changed since, is refused and runs nothing", async () => {
      const posted = await post(decision(SECRET))
      const sink = stub()
      const deps = { actor, run: sink.run }
      const stale = await store.provideSecret(
        db,
        posted.id,
        { seen: "2026-01-01T00:00:00.000Z", value: VALUE },
        deps,
      )
      expect(stale).toMatchObject({ code: "CONFLICT", ok: false })
      expect(sink.calls).toHaveLength(0)
      const [one, two] = await Promise.all([
        store.provideSecret(db, posted.id, { value: VALUE }, deps),
        store.provideSecret(db, posted.id, { value: VALUE }, deps),
      ])
      expect([one.ok, two.ok].sort()).toEqual([false, true])
      expect(sink.calls).toHaveLength(2)
      expect(JSON.stringify([one, two])).not.toContain(VALUE)
    })

    test("keeps a poster's close that lands while the sink runs", async () => {
      const posted = await post(decision(SECRET))
      const run = async () => {
        const claimed = await store.getItem(db, posted.id)
        if (claimed) await store.readAnswer(db, claimed)
        return 0
      }
      const provided = await store.provideSecret(db, posted.id, { value: VALUE }, { actor, run })
      expect(provided.ok && provided.item.answer).toMatchObject({
        ackedAt: expect.any(String),
        choice: "provided",
        results: [
          { environment: "production", exitCode: 0 },
          { environment: "preview", exitCode: 0 },
        ],
      })
    })

    test("is refused on any other item, and the item takes no other answer", async () => {
      const ask = await post(decision(PREVIEWS.ask))
      const sink = stub()
      const refused = await store.provideSecret(
        db,
        ask.id,
        { value: VALUE },
        { actor, run: sink.run },
      )
      expect(refused).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      expect(sink.calls).toHaveLength(0)
      const secret = await post(decision(SECRET))
      expect(await store.answerItem(db, secret.id, { action: "approve" }, { actor })).toMatchObject(
        { ok: false },
      )
      expect((await store.getItem(db, secret.id))?.status).toBe("open")
    })

    // PG-1023: a reveal card shows a Keychain item on the owner's click, only while open, and writes nothing
    const REVEAL = { service: "playground-glm", type: "reveal", why: "Set up GLM on a new Mac" }

    test("a reveal card shows its item's value in the return alone, and the row, the log and every table hold none of it", async () => {
      const posted = await post(decision(REVEAL))
      const asked: string[] = []
      const logged: string[] = []
      const console_ = { error: console.error, log: console.log, warn: console.warn }
      for (const name of ["error", "log", "warn"] as const)
        console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
      let shown: Awaited<ReturnType<typeof store.revealSecret>>
      try {
        shown = await store.revealSecret(db, posted.id, async (item) => {
          asked.push(item)
          return VALUE
        })
      } finally {
        Object.assign(console, console_)
      }
      expect(shown).toEqual({ ok: true, value: VALUE })
      expect(asked).toEqual(["playground-glm"])
      const after = await store.getItem(db, posted.id)
      expect(after?.status).toBe("open")
      expect(after?.version).toBe(posted.version)
      expect(JSON.stringify(after)).not.toContain(VALUE)
      expect(logged.join("\n")).not.toContain(VALUE)
      expect(await everyRow()).not.toContain(VALUE)
    })

    test("a reveal card names a playground- service alone", () => {
      for (const service of ["github.com", "slack", "Chrome Safe Storage"])
        expect(inboxInputSchema.safeParse(decision({ ...REVEAL, service })).success).toBe(false)
      expect(inboxInputSchema.safeParse(decision(REVEAL)).success).toBe(true)
    })

    test("a closed, archived or dismissed reveal card, or any other card, shows nothing and never reads the Keychain", async () => {
      const asked: string[] = []
      const read = async (item: string) => {
        asked.push(item)
        return VALUE
      }
      const done = await post(decision(REVEAL))
      await store.answerItem(db, done.id, { action: "approve" }, { actor })
      const dismissed = await post(decision(REVEAL))
      await store.answerItem(db, dismissed.id, { action: "dismiss" }, { actor })
      const archived = await post(decision(REVEAL))
      await store.answerItem(db, archived.id, { action: "archive" }, { actor })
      for (const card of [done, dismissed, archived])
        expect(await store.revealSecret(db, card.id, read)).toMatchObject({
          code: "CONFLICT",
          ok: false,
        })
      const ask = await post(decision(PREVIEWS.ask))
      expect(await store.revealSecret(db, ask.id, read)).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
      expect(await store.revealSecret(db, crypto.randomUUID(), read)).toMatchObject({
        code: "NOT_FOUND",
        ok: false,
      })
      expect(asked).toEqual([])
    })

    // a Copy pasted into the card's own comment box would type the value into its poster's transcript, so a reply or an answer's note that holds it is refused before anything is sent
    test("a reveal card's reply or note that holds its value is refused and sends nothing, while other words go, and its Edit is refused", async () => {
      const posted = await post({ ...decision(REVEAL), from: "dispatcher" })
      const sent: Delivery[] = []
      const deliver = async (delivery: Delivery) => {
        sent.push(delivery)
        return { at: "2026-11-05T22:00:00.000Z", ok: true as const, sessionId: "s1" }
      }
      const reveal = async () => VALUE
      const refused = {
        code: "VALIDATION_ERROR",
        message: "That is the card's value: it stays out of a comment",
        ok: false,
      } as const
      expect(
        await store.replyItem(
          db,
          posted.id,
          { text: `here: ${VALUE}` },
          { actor, deliver, reveal },
        ),
      ).toEqual(refused)
      expect(
        await store.answerItem(
          db,
          posted.id,
          { action: "approve", note: VALUE, option: 0 },
          { actor, deliver, reveal },
        ),
      ).toEqual(refused)
      expect(sent).toEqual([])
      expect(await everyRow()).not.toContain(VALUE)
      expect(
        await store.answerItem(db, posted.id, { action: "edit", text: "other words" }, { actor }),
      ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      const replied = await store.replyItem(
        db,
        posted.id,
        { text: "Pasted it, thanks" },
        { actor, deliver, reveal },
      )
      expect(replied.ok).toBe(true)
      expect(sent.map((delivery) => delivery.text)).toEqual([
        `re #i${posted.ref}: Pasted it, thanks`,
      ])
    })

    test("a reveal card's value refuses a comment from 8 characters on: 7 is no match, since a substring match of a short value would find it in most words (#1102)", async () => {
      const posted = await post({ ...decision(REVEAL), from: "dispatcher" })
      const sent: Delivery[] = []
      const deliver = async (delivery: Delivery) => {
        sent.push(delivery)
        return { at: "2026-11-05T22:00:00.000Z", ok: true as const, sessionId: "s1" }
      }
      const reply = (value: string) =>
        store.replyItem(
          db,
          posted.id,
          { text: "about the tab" },
          { actor, deliver, reveal: async () => value },
        )
      expect((await reply("about t")).ok).toBe(true)
      expect(await reply("about th")).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      expect(sent.map((delivery) => delivery.text)).toEqual([`re #i${posted.ref}: about the tab`])
    })

    test("a comment on any other card never reads the Keychain", async () => {
      const posted = await post(decision(PREVIEWS.ask))
      const asked: string[] = []
      const replied = await store.replyItem(
        db,
        posted.id,
        { text: VALUE },
        {
          actor,
          deliver: async () => ({ at: "2026-11-05T22:00:00.000Z", ok: true, sessionId: "s1" }),
          reveal: async (item) => {
            asked.push(item)
            return VALUE
          },
        },
      )
      expect(replied.ok).toBe(true)
      expect(asked).toEqual([])
    })

    test("an item with no value of its shape reads not found, naming no value", async () => {
      const posted = await post(decision(REVEAL))
      expect(await store.revealSecret(db, posted.id, async () => null)).toEqual({
        code: "NOT_FOUND",
        message: "That Keychain item holds no value",
        ok: false,
      })
    })

    test("a secret ask may name a playground- service, which takes the untyped check", async () => {
      const posted = await post(
        decision({
          key: "GLM_KEY",
          sink: { item: "playground-glm", type: "keychain" },
          type: "secret",
        }),
      )
      const saved: { item: string; value: string }[] = []
      const keychain = async (item: string, value: string) => void saved.push({ item, value })
      const refused = await store.provideSecret(
        db,
        posted.id,
        { value: 'a"b' },
        { actor, keychain, run: stub().run },
      )
      expect(refused).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      const provided = await store.provideSecret(
        db,
        posted.id,
        { value: VALUE },
        { actor, keychain, run: stub().run },
      )
      expect(provided.ok).toBe(true)
      expect(saved).toEqual([{ item: "playground-glm", value: VALUE }])
    })
  })

  describe("an accept decision's Approve (PG-658)", () => {
    // what the stubbed runner was handed, per call, and what it answers
    const runner = (ran: Partial<{ code: number; err: string; out: string }> = {}) => {
      const calls: string[][] = []
      const accept = async (args: string[]) => {
        calls.push(args)
        return { code: 0, err: "", out: "rev 9b8c7d6 is accepted", ...ran }
      }
      return { accept, calls }
    }

    test("runs the one fixed argv once the answer is kept, records its exit code and line, and tells the poster there is nothing left to do", async () => {
      const posted = await post(decision(ACCEPT))
      const run = runner()
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: posted.updatedAt },
        {
          accept: run.accept,
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-03T20:00:00.000Z", ok: true, sessionId: "s1" }
          },
        },
      )
      expect(run.calls).toEqual([
        [
          "accept",
          "acme",
          "skill",
          "end-of-day",
          "3f9a2c1d",
          "--reason",
          `the owner approved it in the Inbox (#i${posted.ref})`,
        ],
      ])
      expect(answered.ok).toBe(true)
      if (!answered.ok) return
      expect(answered.item.status).toBe("approved")
      expect(answered.item.answer).toMatchObject({
        accepted: { exitCode: 0, line: "rev 9b8c7d6 is accepted" },
        choice: "approve",
      })
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        accepted: { exitCode: 0, line: "rev 9b8c7d6 is accepted" },
      })
      expect(sent).toHaveLength(1)
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        accepted: { exitCode: 0, line: "rev 9b8c7d6 is accepted" },
        close: `playground ask ack #i${posted.ref} --no-link "<why>"`,
        next: "nothing",
      })
    })

    test("a refused accept records the CLI's exit code and its error line, and the poster reads that nothing was accepted", async () => {
      const posted = await post(decision(ACCEPT))
      const run = runner({
        code: 1,
        err: "playground ext: 409 the proposal is at 0a1b2c3d4e5f, not 3f9a2c1d; read it again",
        out: "",
      })
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        {
          accept: run.accept,
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-03T20:00:00.000Z", ok: true, sessionId: "s1" }
          },
        },
      )
      expect(answered.ok && answered.item.answer).toMatchObject({
        accepted: {
          exitCode: 1,
          line: "playground ext: 409 the proposal is at 0a1b2c3d4e5f, not 3f9a2c1d; read it again",
        },
      })
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        accepted: { exitCode: 1 },
        next: "nothing",
      })
    })

    test("a list is accepted in order on Approve and stops at the first failure, the rest not tried, its line naming each (PG-1149)", async () => {
      const posted = await post(
        decision({ ...ACCEPT, more: [MORE_B, MORE_C, { ...MORE_C, key: "late-reply" }] }),
      )
      const calls: string[] = []
      const accept = async (args: string[]) => {
        calls.push(`${args[2]} ${args[3]}`)
        return args[3] === "quiet-hours"
          ? { code: 1, err: "playground ext: 400 the revision holds a token", out: "" }
          : { code: 0, err: "", out: `rev ${args[4]} is accepted` }
      }
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: posted.updatedAt },
        { accept, actor },
      )
      expect(calls).toEqual(["skill end-of-day", "doc handover", "rule quiet-hours"])
      expect(answered.ok && answered.item.answer).toMatchObject({
        accepted: {
          exitCode: 1,
          line: "accepted skill end-of-day in acme, doc handover in acme; rule quiet-hours in acme failed: playground ext: 400 the revision holds a token; not tried: rule late-reply in acme",
        },
      })
      const all = await post(decision({ ...ACCEPT, more: [MORE_B] }))
      const ok = async (args: string[]) => ({ code: 0, err: "", out: `rev ${args[4]} is accepted` })
      const done = await store.answerItem(db, all.id, { action: "approve" }, { accept: ok, actor })
      expect(done.ok && done.item.answer).toMatchObject({
        accepted: { exitCode: 0, line: "accepted skill end-of-day in acme, doc handover in acme" },
      })
    })

    test("a list runs on the owner's Approve alone: Deny, Archive and Dismiss run none of it (PG-1149)", async () => {
      const calls: string[][] = []
      const accept = async (args: string[]) => (
        calls.push(args),
        { code: 0, err: "", out: "accepted" }
      )
      for (const action of ["deny", "archive", "dismiss"] as const) {
        const posted = await post(decision({ ...ACCEPT, more: [MORE_B, MORE_C] }))
        const answered = await store.answerItem(db, posted.id, { action }, { accept, actor })
        expect(answered.ok, action).toBe(true)
      }
      expect(calls).toEqual([])
    })

    test("a proposal whose rev moved after the card was posted is refused by the store, and the list stops there (PG-1149)", async () => {
      const data = mkdtempSync(join(tmpdir(), "inbox-accept-list-"))
      try {
        const scope = "made-up-me"
        setSetting(
          data,
          { key: "clock.ownerZone", scope, value: "Europe/Lisbon" },
          { actor: "cli", author: "owner", inboxRef: null, reason: "seeded" },
        )
        const worker = {
          actor: "cli",
          author: "made-up-worker",
          inboxRef: null,
          reason: "a new version",
        }
        const files = (text: string) => ({
          attachments: [],
          body: null,
          files: { "cli.ts": `console.log("${text}")` },
          value: null,
        })
        const revOf = (outcome: ReturnType<typeof putItem>) => {
          if (!outcome.ok) throw new Error(outcome.message)
          return outcome.rev
        }
        const first = {
          key: "relay-a",
          kind: "script" as const,
          rev: revOf(
            putItem(data, { key: "relay-a", kind: "script", scope }, files("a"), worker, false),
          ),
          scope,
        }
        const moved = {
          key: "relay-b",
          kind: "script" as const,
          rev: revOf(
            putItem(data, { key: "relay-b", kind: "script", scope }, files("b"), worker, false),
          ),
          scope,
        }
        const last = {
          key: "relay-c",
          kind: "script" as const,
          rev: revOf(
            putItem(data, { key: "relay-c", kind: "script", scope }, files("c"), worker, false),
          ),
          scope,
        }
        const posted = await post(
          decision({
            ...first,
            more: [moved, last],
            type: "accept",
            why: "Three made-up scripts that land as one change",
          }),
        )
        const newer = revOf(
          putItem(data, { key: "relay-b", kind: "script", scope }, files("b2"), worker, false),
        )
        // the store's own accept, as `playground ext accept` runs it, its refusal as the CLI prints one
        const tried: string[] = []
        const accept = async (args: string[]) => {
          const [, s, kind, key, rev] = args as [string, string, "script", string, string]
          tried.push(key)
          const judged = judgeItem(
            data,
            { key, kind, scope: s },
            rev,
            { kind: "accept" },
            { actor: "dashboard", author: "owner", inboxRef: posted.ref, reason: "approved" },
          )
          return judged.ok
            ? { code: 0, err: "", out: `rev ${judged.rev.slice(0, 7)} is accepted` }
            : { code: 1, err: `playground ext: ${judged.status} ${judged.message}`, out: "" }
        }
        const answered = await store.answerItem(
          db,
          posted.id,
          { action: "approve" },
          { accept, actor },
        )
        expect(tried).toEqual(["relay-a", "relay-b"])
        expect(answered.ok && answered.item.answer).toMatchObject({
          accepted: {
            exitCode: 1,
            line: expect.stringMatching(
              new RegExp(
                `^accepted script relay-a in made-up-me; script relay-b in made-up-me failed: playground ext: 409 the proposal is at ${newer.slice(0, 12)}, not ${moved.rev}; read it again; not tried: script relay-c in made-up-me$`,
              ),
            ),
          },
        })
      } finally {
        rmSync(data, { force: true, recursive: true })
      }
    })

    test("a runner that throws is recorded as a failed accept, never an approve with no result", async () => {
      const posted = await post(decision(ACCEPT))
      const accept = async () => {
        throw new Error("spawn ENOENT")
      }
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        { accept, actor },
      )
      expect(answered.ok && answered.item.answer).toMatchObject({
        accepted: { exitCode: 1, line: "spawn ENOENT" },
      })
    })

    test("runs once: a double click, or an answer to a card read before it changed, runs one accept or none", async () => {
      const posted = await post(decision(ACCEPT))
      const run = runner()
      const stale = await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: "2026-01-01T00:00:00.000Z" },
        { accept: run.accept, actor },
      )
      expect(stale).toMatchObject({ code: "CONFLICT", ok: false })
      expect(run.calls).toHaveLength(0)
      const [one, two] = await Promise.all([
        store.answerItem(db, posted.id, { action: "approve" }, { accept: run.accept, actor }),
        store.answerItem(db, posted.id, { action: "approve" }, { accept: run.accept, actor }),
      ])
      expect([one.ok, two.ok].sort()).toEqual([false, true])
      expect(run.calls).toHaveLength(1)
    })

    test("Deny and Archive run nothing, and Edit is refused with the item left open", async () => {
      const run = runner()
      const denied = await post(decision(ACCEPT))
      const cleared = await post(decision(ACCEPT))
      const edited = await post(decision(ACCEPT))
      const deps = { accept: run.accept, actor }
      expect(await store.answerItem(db, denied.id, { action: "deny" }, deps)).toMatchObject({
        item: { status: "denied" },
        ok: true,
      })
      expect(await store.answerItem(db, cleared.id, { action: "clear" }, deps)).toMatchObject({
        item: { status: "cleared" },
        ok: true,
      })
      expect(
        await store.answerItem(db, edited.id, { action: "edit", text: "accept core's" }, deps),
      ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      expect((await store.getItem(db, edited.id))?.status).toBe("open")
      expect(run.calls).toHaveLength(0)
    })

    test("with no runner its Approve is refused and the item stays open, and no other decision ever runs one", async () => {
      const posted = await post(decision(ACCEPT))
      expect(await store.answerItem(db, posted.id, { action: "approve" }, { actor })).toMatchObject(
        {
          code: "VALIDATION_ERROR",
          message: "This dashboard cannot run an accept",
          ok: false,
        },
      )
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
      const run = runner()
      const other = await post(decision(PREVIEWS.delete))
      expect(
        await store.answerItem(db, other.id, { action: "approve" }, { accept: run.accept, actor }),
      ).toMatchObject({ ok: true })
      expect(run.calls).toHaveLength(0)
    })

    test("an accept answered for an ended poster reaches the dispatcher as an item to close, not a go", async () => {
      const posted = await post({ ...decision(ACCEPT), from: "worker-eod" })
      const sent: Delivery[] = []
      await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        {
          accept: runner().accept,
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return afterPoster(delivery)
          },
          dispatcher: "dispatcher",
        },
      )
      const relayed = sent.find((delivery) => delivery.to === "dispatcher")
      const relayedPayload = payloadOf(relayed?.text ?? "")
      expect(relayedPayload).toMatchObject({
        close: `playground ask ack #i${posted.ref} --no-link "<why>"`,
        next: "nothing",
        relay: { for: "worker-eod", why: "poster-ended" },
      })
      expect(relayedPayload?.accepted).toEqual({ exitCode: 0, line: "rev 9b8c7d6 is accepted" })
      // an approved accept is a go, which get --ack leaves open, so the relay names the one close that closes it
      expect(relayed?.text).not.toContain("--ack")
    })
  })

  describe("a grant decision's Approve (PG-658)", () => {
    const opener = (ran: Partial<{ code: number; err: string; out: string }> = {}) => {
      const calls: string[][] = []
      const grant = async (argv: string[]) => {
        calls.push(argv)
        return { code: 0, err: "", out: "", ...ran }
      }
      return { calls, grant }
    }

    test("opens the permission's pane once, records it, and tells the poster to recheck the grant", async () => {
      const posted = await post(decision(GRANT))
      const run = opener()
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: posted.updatedAt },
        {
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-03T20:00:00.000Z", ok: true, sessionId: "s1" }
          },
          grant: run.grant,
        },
      )
      expect(run.calls).toEqual([
        [
          "/usr/bin/open",
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ],
      ])
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        choice: "approve",
        opened: {
          exitCode: 0,
          line: "opened System Settings at Privacy & Security > Screen Recording",
        },
      })
      expect(answered.ok && answered.item.status).toBe("approved")
      // the pane opened, so the poster carries out the recheck asks.md names, then closes it
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        close: `playground ask ack #i${posted.ref} --no-link "<why>"`,
        next: "carry-out",
        opened: { exitCode: 0 },
        type: "grant",
        verb: "pick",
      })
    })

    test("an open that fails is recorded, and the poster reads that nothing opened", async () => {
      const posted = await post(decision(GRANT))
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        {
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-03T20:00:00.000Z", ok: true, sessionId: "s1" }
          },
          grant: opener({ code: 1, err: "LSOpenURLsWithRole() failed with error -10814" }).grant,
        },
      )
      expect(answered.ok && answered.item.answer).toMatchObject({
        opened: { exitCode: 1, line: "LSOpenURLsWithRole() failed with error -10814" },
      })
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        next: "nothing",
        opened: { exitCode: 1, line: "LSOpenURLsWithRole() failed with error -10814" },
      })
    })

    test("with no opener, as on a stack showing test data, its Approve is refused and the item stays open; Deny opens nothing", async () => {
      const posted = await post(decision(GRANT))
      expect(await store.answerItem(db, posted.id, { action: "approve" }, { actor })).toMatchObject(
        { code: "VALIDATION_ERROR", ok: false },
      )
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
      const run = opener()
      const denied = await post(decision(GRANT))
      await store.answerItem(db, denied.id, { action: "deny" }, { actor, grant: run.grant })
      expect(run.calls).toHaveLength(0)
    })
  })

  describe("an apps decision's Approve (PG-658)", () => {
    const owner = (
      list: string[] | null,
      ran: Partial<{ code: number; err: string; out: string }> = {},
    ) => {
      const calls: { args: string[]; stdin?: string }[] = []
      return {
        apps: {
          login: "owner",
          read: () => list,
          run: async (args: string[], stdin?: string) => {
            calls.push({ args, stdin })
            return { code: 0, err: "", out: '{"rev":"9b8c7d6","state":"accepted"}', ...ran }
          },
        },
        calls,
      }
    }

    test("writes the login's own list with the app added, through one put, and records the list", async () => {
      const posted = await post(decision(APPS))
      const run = owner(["Slack"])
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve" },
        {
          actor,
          apps: run.apps,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-03T20:00:00.000Z", ok: true, sessionId: "s1" }
          },
        },
      )
      expect(run.calls).toEqual([
        {
          args: [
            "put",
            "owner",
            "list",
            "desktop-owner-apps",
            "-",
            "--reason",
            `the owner approved it in the Inbox (#i${posted.ref})`,
          ],
          stdin: '["Slack","Notes"]',
        },
      ])
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        listed: { exitCode: 0, line: "added Notes; your apps are Slack, Notes" },
      })
      expect(answered.ok && answered.item.status).toBe("approved")
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        listed: { exitCode: 0, line: "added Notes; your apps are Slack, Notes" },
        next: "nothing",
        type: "apps",
      })
    })

    test("two Approves that overlap change the list one at a time, so neither app is lost", async () => {
      const notes = await post(decision(APPS))
      const mail = await post(decision({ ...APPS, app: "Mail" }))
      let list = ["Slack"]
      let firstStarted!: () => void
      const started = new Promise<void>((resolve) => (firstStarted = resolve))
      let releaseFirst!: () => void
      const held = new Promise<void>((resolve) => (releaseFirst = resolve))
      let puts = 0
      const apps = {
        login: "owner",
        read: () => list,
        run: async (_args: string[], stdin?: string) => {
          if (++puts === 1) {
            firstStarted()
            await held
          }
          list = JSON.parse(stdin ?? "[]")
          return { code: 0, err: "", out: '{"rev":"9b8c7d6","state":"accepted"}' }
        },
      }
      const first = store.answerItem(db, notes.id, { action: "approve" }, { actor, apps })
      await started
      const second = store.answerItem(db, mail.id, { action: "approve" }, { actor, apps })
      while ((await store.getItem(db, mail.id))?.status === "open") await Bun.sleep(5)
      await Bun.sleep(10)
      releaseFirst()
      await Promise.all([first, second])
      expect(list).toEqual(["Slack", "Notes", "Mail"])
      expect((await store.getItem(db, mail.id))?.answer).toMatchObject({
        listed: { exitCode: 0, line: "added Mail; your apps are Slack, Notes, Mail" },
      })
    })

    test("removing an app the list does not hold, or a list that is not names, writes nothing and records why", async () => {
      const absent = await post(decision({ ...APPS, change: "remove" }))
      const run = owner(["Slack"])
      expect(
        await store.answerItem(db, absent.id, { action: "approve" }, { actor, apps: run.apps }),
      ).toMatchObject({
        item: {
          answer: {
            listed: { exitCode: 1, line: "Notes is not on your own apps list, so nothing changed" },
          },
        },
      })
      const broken = await post(decision(APPS))
      const bad = owner(null)
      expect(
        await store.answerItem(db, broken.id, { action: "approve" }, { actor, apps: bad.apps }),
      ).toMatchObject({ item: { answer: { listed: { exitCode: 1 } } } })
      expect([...run.calls, ...bad.calls]).toEqual([])
    })

    test("a refused put records the CLI's exit code and its error line", async () => {
      const posted = await post(decision(APPS))
      const run = owner([], {
        code: 1,
        err: "playground ext: 403 a session writes no list",
        out: "",
      })
      expect(
        await store.answerItem(db, posted.id, { action: "approve" }, { actor, apps: run.apps }),
      ).toMatchObject({
        item: {
          answer: { listed: { exitCode: 1, line: "playground ext: 403 a session writes no list" } },
        },
      })
    })

    test("with no login its Approve is refused and the item stays open; Deny and Archive write nothing", async () => {
      const posted = await post(decision(APPS))
      expect(await store.answerItem(db, posted.id, { action: "approve" }, { actor })).toMatchObject(
        { code: "VALIDATION_ERROR", ok: false },
      )
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
      const run = owner([])
      const denied = await post(decision(APPS))
      const cleared = await post(decision(APPS))
      await store.answerItem(db, denied.id, { action: "deny" }, { actor, apps: run.apps })
      await store.answerItem(db, cleared.id, { action: "clear" }, { actor, apps: run.apps })
      expect(run.calls).toHaveLength(0)
    })
  })

  describe("a guard decision's Approve (PG-1090)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "inbox-guard-"))
    afterAll(() => rmSync(scratch, { force: true, recursive: true }))
    let n = 0
    // a data folder whose extensions have a made-up login, as ext init leaves them
    const folder = () => {
      const data = join(scratch, `data-${n++}`)
      mkdirSync(dirname(loginPath(data)), { recursive: true })
      writeFileSync(loginPath(data), "made-up-me\n")
      return data
    }
    const atOrg = (data: string) =>
      readSetting(data, "slack.gatedSends")?.rows.filter((row) => row.scope === "acme-test")
    const approve = (id: string, seen: string | undefined, settings?: string) =>
      store.answerItem(db, id, { action: "approve", seen }, { actor, settingsData: settings })

    test("writes the card's value at its scope as the owner's act, and records the line under set", async () => {
      const data = folder()
      const posted = await post(decision(GUARD))
      const sent: Delivery[] = []
      const answered = await store.answerItem(
        db,
        posted.id,
        { action: "approve", seen: posted.updatedAt },
        {
          actor,
          deliver: async (delivery) => {
            sent.push(delivery)
            return { at: "2026-11-06T03:00:00.000Z", ok: true, sessionId: "s1" }
          },
          settingsData: data,
        },
      )
      expect(answered.ok && answered.item.status).toBe("approved")
      expect(atOrg(data)).toEqual([{ key: "slack.gatedSends", scope: "acme-test", value: GATE }])
      const line = `set slack.gatedSends at acme-test to ${JSON.stringify(GATE)}`
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        set: { exitCode: 0, line },
      })
      expect(payloadOf(sent[0]?.text ?? "")).toMatchObject({
        next: "nothing",
        set: { exitCode: 0, line },
        type: "guard",
      })
      expect(settingHistory(data, "slack.gatedSends")?.[0]?.reason).toBe(
        `the owner approved it in the Inbox (#i${posted.ref})`,
      )
    })

    test("a card its poster changed after the owner read it cannot be approved with the old reading", async () => {
      const data = folder()
      const posted = await post(decision(GUARD))
      const other = { ...GATE, selfDm: "D0MADEUP2" }
      // edited inside the millisecond it was posted in, as CI's fast runner once did, so only a fresh stamp tells the two readings apart
      const edited = await store.editItem(
        db,
        posted.id,
        decision({ ...GUARD, value: other }),
        new Date(posted.updatedAt),
      )
      expect(edited.ok && edited.item.version).toBeGreaterThan(posted.version)
      expect(await approve(posted.id, posted.updatedAt, data)).toMatchObject({
        code: "CONFLICT",
        ok: false,
      })
      expect(await approve(posted.id, undefined, data)).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
      expect(atOrg(data)).toEqual([])
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
      const now = (await store.getItem(db, posted.id))!
      expect((await approve(posted.id, now.updatedAt, data)).ok).toBe(true)
      expect(atOrg(data)).toEqual([{ key: "slack.gatedSends", scope: "acme-test", value: other }])
    })

    test("a card with no value takes the setting back to its default, and Deny writes nothing", async () => {
      const data = folder()
      const who = { actor: "test", author: "owner", inboxRef: null, reason: "seeded" }
      expect(
        setSetting(data, { key: "slack.gatedSends", scope: "acme-test", value: GATE }, who).ok,
      ).toBe(true)
      const { value: _, ...cleared } = GUARD
      const off = await post(decision(cleared))
      expect((await approve(off.id, off.updatedAt, data)).ok).toBe(true)
      expect(atOrg(data)).toEqual([])
      expect((await store.getItem(db, off.id))?.answer).toMatchObject({
        set: { exitCode: 0, line: "took slack.gatedSends at acme-test back to its default" },
      })
      const denied = await post(decision(GUARD))
      await store.answerItem(
        db,
        denied.id,
        { action: "deny", seen: denied.updatedAt },
        {
          actor,
          settingsData: data,
        },
      )
      const set = await post(decision(GUARD))
      await store.answerItem(db, set.id, { action: "clear" }, { actor, settingsData: data })
      expect(atOrg(data)).toEqual([])
    })

    test("a job's Approve stores its enabled field alone at its scope, so every other field still reads the registry's (PG-1196)", async () => {
      const data = folder()
      const key = "jobs.opsZaiUsage"
      const card = { ...GUARD, key, scope: "made-up-me", value: { enabled: true } }
      const posted = await post(decision(card))
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      const read = readSetting(data, key)!
      expect(read.rows).toEqual([{ key, scope: "made-up-me", value: { enabled: true } }])
      expect(read.value).toEqual({ ...(read.default as object), enabled: true })
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        set: { exitCode: 0, line: `set ${key} at made-up-me to {"enabled":true}` },
      })
      const again = await post(decision(card))
      expect((await approve(again.id, again.updatedAt, data)).ok).toBe(true)
      expect((await store.getItem(db, again.id))?.answer).toMatchObject({
        set: {
          exitCode: 0,
          line: `${key} at made-up-me is already {"enabled":true}, so nothing changed`,
        },
      })
    })

    test("an org's own job's Approve places its whole row, and approving the same row again changes nothing (PG-1363)", async () => {
      const data = folder()
      writeFiles(data, "acme-test", new Map([["scripts/ops-watch/cli.ts", "console.log(1)"]]), {
        author: "owner",
        reason: "ship the script",
      })
      const key = "jobs.opsWatch"
      const row = {
        callsModel: false,
        command: "{bun} --no-env-file {data}/ops/ops-watch/cli.ts",
        description: "Watches an org's own queue.",
        enabled: true,
        heartbeat: "ops-watch",
        schedule: { every: 60 },
      }
      const card = { ...GUARD, key, scope: "acme-test", value: row }
      const posted = await post(decision(card))
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        set: { exitCode: 0, line: expect.stringContaining(`set ${key} at acme-test to {`) },
      })
      const again = await post(decision(card))
      expect((await approve(again.id, again.updatedAt, data)).ok).toBe(true)
      expect((await store.getItem(db, again.id))?.answer).toMatchObject({
        set: {
          exitCode: 0,
          line: expect.stringMatching(
            new RegExp(`^${key} at acme-test is already \\{.*\\}, so nothing changed$`),
          ),
        },
      })
    })

    test("an org's own job's enabled or config Approve writes it over the org's row, and is refused while the org holds none (#1336)", async () => {
      const data = folder()
      const key = "jobs.opsWatch"
      const scope = "acme-test"
      const row = {
        callsModel: false,
        command: "{bun} --no-env-file {data}/ops/ops-watch/cli.ts",
        config: { prefixes: ["X"] },
        description: "Watches an org's own queue.",
        enabled: true,
        heartbeat: "ops-watch",
        schedule: { every: 60 },
      }
      const answer = async (value: object) => {
        const posted = await post(decision({ ...GUARD, key, scope, value }))
        expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
        return ((await store.getItem(db, posted.id))!.answer as { set: { line: string } }).set.line
      }
      expect(await answer({ enabled: false })).toBe(`${key} has no row at ${scope} to change`)
      writeFiles(data, scope, new Map([["scripts/ops-watch/cli.ts", "console.log(1)"]]), {
        author: "owner",
        reason: "ship the script",
      })
      const who = { actor: "test", author: "owner", inboxRef: null, reason: "seeded" }
      expect(setSetting(data, { key, scope, value: row }, who).ok).toBe(true)
      const stored = () =>
        settingRows(data).find((each) => each.key === key && each.scope === scope)
      expect(await answer({ enabled: false })).toStartWith(`set ${key} at ${scope} to {`)
      expect(stored()?.value).toEqual({ ...row, enabled: false })
      expect(await answer({ config: { prefixes: ["Y"] } })).toStartWith(
        `set ${key} at ${scope} to {`,
      )
      expect(stored()?.value).toEqual({ ...row, config: { prefixes: ["Y"] }, enabled: false })
      // with its script folder gone, the merged row no longer passes the org job's check, so turning it on is refused and the row stays
      writeFiles(data, scope, new Map([["scripts/ops-watch/cli.ts", null]]), {
        author: "owner",
        reason: "remove the script",
      })
      const on = await answer({ enabled: true })
      expect(on).toStartWith(`${key}: `)
      expect(stored()?.value).toEqual({ ...row, config: { prefixes: ["Y"] }, enabled: false })
    })

    test("a job's Approve keeps the other fields its scope's row holds, and stores no registry field (PG-1196)", async () => {
      const data = folder()
      const key = "jobs.opsZaiUsage"
      const who = { actor: "test", author: "owner", inboxRef: null, reason: "seeded" }
      const row = { enabled: false, schedule: { every: 7 } }
      expect(setSetting(data, { key, scope: "made-up-me", value: row }, who).ok).toBe(true)
      const card = { ...GUARD, key, scope: "made-up-me", value: { enabled: true } }
      const posted = await post(decision(card))
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      expect(readSetting(data, key)!.rows).toEqual([
        { key, scope: "made-up-me", value: { enabled: true, schedule: { every: 7 } } },
      ])
    })

    test("a job's config Approve writes that object alone over its scope's row, every other field kept (#1336)", async () => {
      const data = folder()
      const key = "jobs.opsSweep"
      const who = { actor: "test", author: "owner", inboxRef: null, reason: "seeded" }
      const row = { config: { hours: "00-23" }, enabled: true, schedule: { every: 7 } }
      expect(setSetting(data, { key, scope: "made-up-me", value: row }, who).ok).toBe(true)
      const config = { hours: "09-18", made: ["up"] }
      const card = { ...GUARD, key, scope: "made-up-me", value: { config } }
      const posted = await post(decision(card))
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      expect(readSetting(data, key)!.rows).toEqual([
        { key, scope: "made-up-me", value: { config, enabled: true, schedule: { every: 7 } } },
      ])
      // the stored answer is jsonb, which orders an object's keys its own way, so the line's JSON is read back rather than matched as text
      const set = (
        (await store.getItem(db, posted.id))!.answer as { set: { exitCode: number; line: string } }
      ).set
      expect(set.exitCode).toBe(0)
      const prefix = `set ${key} at made-up-me to `
      expect(set.line.startsWith(prefix)).toBe(true)
      expect(JSON.parse(set.line.slice(prefix.length))).toEqual({
        config,
        enabled: true,
        schedule: { every: 7 },
      })
      expect(settingHistory(data, key)?.[0]?.reason).toBe(
        `the owner approved it in the Inbox (#i${posted.ref})`,
      )
    })

    test("with no data folder its Approve is refused and the item stays open", async () => {
      const posted = await post(decision(GUARD))
      expect(await approve(posted.id, posted.updatedAt)).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
      expect((await store.getItem(db, posted.id))?.status).toBe("open")
    })
  })
  describe("an own decision's post and Approve (PG-1162)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "inbox-own-"))
    afterAll(() => rmSync(scratch, { force: true, recursive: true }))
    let n = 0
    const who = { actor: "test", author: "owner", inboxRef: null, reason: "seeded" }
    // a data folder with a made-up login whose usage.accounts holds the made-up rows
    const folder = () => {
      const data = join(scratch, `data-${n++}`)
      mkdirSync(dirname(loginPath(data)), { recursive: true })
      writeFileSync(loginPath(data), "made-up-me\n")
      expect(
        setSetting(data, { key: "usage.accounts", scope: "made-up-me", value: ACCOUNTS }, who).ok,
      ).toBe(true)
      return data
    }
    const rows = (data: string) =>
      readSetting(data, "usage.accounts")?.rows.find((row) => row.scope === "made-up-me")?.value
    const writes = (data: string) => settingHistory(data, "usage.accounts")?.length ?? 0
    const postOwn = async (preview: object, data?: string) => {
      const posted = await store.postItem(db, decision(preview), undefined, undefined, data)
      if (!posted.ok) throw new Error(posted.message)
      return posted.item
    }
    const approve = (id: string, seen: string | undefined, data?: string) =>
      store.answerItem(db, id, { action: "approve", seen }, { actor, settingsData: data })

    test("Approve sets own on the named row alone, as the owner's act, and records the line under owned", async () => {
      const data = folder()
      const posted = await postOwn(OWN, data)
      const answered = await approve(posted.id, posted.updatedAt, data)
      expect(answered.ok && answered.item.status).toBe("approved")
      expect(rows(data)).toEqual([{ ...ACCOUNTS[0], own: true }, ACCOUNTS[1], ACCOUNTS[2]])
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        owned: { exitCode: 0, line: "pat@example.com is now your own account at made-up-me" },
      })
      expect(settingHistory(data, "usage.accounts")?.[0]?.reason).toBe(
        `the owner approved it in the Inbox (#i${posted.ref})`,
      )
    })

    test("a second card with own false clears the flag, and every other row reads as it was", async () => {
      const data = folder()
      const posted = await postOwn({ ...OWN, key: "sam@example.com", own: false }, data)
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      expect(rows(data)).toEqual([ACCOUNTS[0], { email: "sam@example.com" }, ACCOUNTS[2]])
    })

    test("a row already in the asked state writes nothing and says so", async () => {
      const data = folder()
      const before = writes(data)
      const posted = await postOwn({ ...OWN, key: "sam@example.com" }, data)
      expect((await approve(posted.id, posted.updatedAt, data)).ok).toBe(true)
      expect(writes(data)).toBe(before)
      expect(rows(data)).toEqual(ACCOUNTS)
      expect((await store.getItem(db, posted.id))?.answer).toMatchObject({
        owned: { exitCode: 0, line: "sam@example.com is your own account already" },
      })
    })

    test("an Approve after the list was reset, or after the row left it, refuses with exit 1 and writes nothing", async () => {
      const data = folder()
      const gone = await postOwn(OWN, data)
      const reset = await postOwn({ ...OWN, key: "sam@example.com", own: false }, data)
      expect(
        setSetting(
          data,
          { key: "usage.accounts", scope: "made-up-me", value: ACCOUNTS.slice(1) },
          who,
        ).ok,
      ).toBe(true)
      let before = writes(data)
      expect((await approve(gone.id, gone.updatedAt, data)).ok).toBe(true)
      expect(writes(data)).toBe(before)
      expect((await store.getItem(db, gone.id))?.answer).toMatchObject({
        owned: {
          exitCode: 1,
          line: "pat@example.com is no longer in usage.accounts at made-up-me, so nothing changed",
        },
      })
      expect(resetSetting(data, { key: "usage.accounts", scope: "made-up-me" }, who).ok).toBe(true)
      before = writes(data)
      expect((await approve(reset.id, reset.updatedAt, data)).ok).toBe(true)
      expect(writes(data)).toBe(before)
      expect(rows(data)).toBeUndefined()
      expect((await store.getItem(db, reset.id))?.answer).toMatchObject({
        owned: {
          exitCode: 1,
          line: "usage.accounts at made-up-me is not a list, so nothing changed",
        },
      })
    })

    test("a key that names no Claude row at its scope is refused as it is posted, a GLM label among them, and nothing is posted", async () => {
      const data = folder()
      const before = (await store.openItems(db)).length
      for (const [preview, folderOf] of [
        [{ ...OWN, key: "zai@example.com" }, data],
        [{ ...OWN, key: "nobody@example.com" }, data],
        [{ ...OWN, scope: "acme-test" }, data],
        [OWN, undefined],
      ] as const) {
        const posted = await store.postItem(db, decision(preview), undefined, undefined, folderOf)
        expect(posted, JSON.stringify(preview)).toMatchObject({
          code: "VALIDATION_ERROR",
          ok: false,
        })
      }
      // a GLM row's label is no email, so the schema refuses it before the rows are read
      expect(
        await store.postItem(db, decision({ ...OWN, key: "zai" }), undefined, undefined, data),
      ).toMatchObject({ code: "VALIDATION_ERROR", ok: false })
      expect((await store.openItems(db)).length).toBe(before)
      // the same card naming a Claude row posts, so the refusals above are the key's alone
      expect((await store.postItem(db, decision(OWN), undefined, undefined, data)).ok).toBe(true)
    })

    test("only the owner's Approve with seen writes: Deny, Later, an Approve with no seen and one with no data folder write nothing", async () => {
      const data = folder()
      const before = writes(data)
      const denied = await postOwn(OWN, data)
      await store.answerItem(
        db,
        denied.id,
        { action: "deny", seen: denied.updatedAt },
        { actor, settingsData: data },
      )
      const later = await postOwn(OWN, data)
      await store.answerItem(db, later.id, { action: "clear" }, { actor, settingsData: data })
      const unseen = await postOwn(OWN, data)
      expect(await approve(unseen.id, undefined, data)).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
      expect(await approve(unseen.id, unseen.updatedAt)).toMatchObject({
        code: "VALIDATION_ERROR",
        ok: false,
      })
      expect((await store.getItem(db, unseen.id))?.status).toBe("open")
      expect(writes(data)).toBe(before)
      expect(rows(data)).toEqual(ACCOUNTS)
    })
  })
})
