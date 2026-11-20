import { describe, expect, test } from "bun:test"

import { RELAY_ANSWER_KINDS } from "../../../../../../packages/message/src/index"
import { onRefusal } from "../../../../../../web/next/src/lib/outbox"
import { READ_ONLY_LINE, yardWrites } from "../../../../../../web/next/src/lib/relay"

const read = (file: string) => Bun.file(`web/next/src/components/dashboard/${file}`).text()

const decision = (type: string) => ({ kind: "decision" as const, preview: { type } })

// every card the Inbox draws, by its kind: each decision's preview type, then a draft and an update
const CARDS = [
  ...["ask", "budget", "delete", "schema", "secret", "ship", "slack", "ticket"].map(decision),
  { kind: "draft" as const },
  { kind: "update" as const },
]

// the hosted build's relay carries a write only when this browser's paired key signs it and it is on RELAY_WRITES, so the page offers those writes alone, and none without a key
describe("the hosted dashboard writes only what a paired key signs", () => {
  test("a local stack offers every write, a hosted page with no key none, and a paired one the composer and the listed cards' answers alone", () => {
    const local = yardWrites({ hosted: false, paired: false })
    expect(local.send).toBe(true)
    for (const card of CARDS) expect(local.answers(card)).toBe(true)

    const unpaired = yardWrites({ hosted: true, paired: false })
    expect(unpaired.send).toBe(false)
    for (const card of CARDS) expect(unpaired.answers(card)).toBe(false)

    const paired = yardWrites({ hosted: true, paired: true })
    expect(paired.send).toBe(true)
    const answered = CARDS.filter(paired.answers).map((card) =>
      "preview" in card ? card.preview.type : card.kind,
    )
    expect(answered.toSorted()).toEqual([...RELAY_ANSWER_KINDS])
    expect(paired.answers(decision("delete"))).toBe(false)
    expect(paired.answers(decision("secret"))).toBe(false)
    expect(paired.answers(decision("a kind added later"))).toBe(false)
  })

  // a browser can keep a key the Mac never approved or has revoked, so its reopened page must say why its first write went nowhere
  test("a key the Mac has not paired fails its first write in the Mac's own words, in the message's bubble and on the card", async () => {
    const refusal = "This browser's key is not paired with this Mac"
    expect(await Bun.file("api/hono/src/lib/relay/mac.ts").text()).toContain(`refuse("${refusal}")`)
    const message = { attempts: 0, code: null, id: "m1", unreached: 0 }
    expect(onRefusal(message, { code: "FORBIDDEN", message: refusal }, "Alpha", 0)).toEqual({
      code: "FORBIDDEN",
      id: "m1",
      reason: refusal,
      type: "fail",
    })
    expect(await read("inbox.tsx")).toContain("setError((failure as Error).message)")
  })

  test("the composer opens only where a send goes, and keeps its uploads and pickers on the Mac", async () => {
    const source = await read("composer.tsx")
    expect(source).toContain(
      'return writes.send ? <WritableComposer {...props} /> : <ReadOnlyLine className="mb-2 py-2" />',
    )
    expect(source).toContain("{...(config.hosted ? {} : attachments.dropProps)}")
    expect(source).toContain("if (!config.hosted) attachments.onPaste(event)")
    expect(source).toContain(
      "{!config.hosted && (\n                    <>\n                      <input {...attachments.pickerProps} />",
    )
    expect(source).toContain("{!config.hosted && <SettingPicker label={label} worker={worker} />}")
    expect(READ_ONLY_LINE).toBe("Read-only on Yard: send from your Mac")
  })

  test("the outbox sends only once the page has read that this browser keeps a paired key", async () => {
    const source = await read("../../lib/chat.ts")
    expect(source).toContain("readOnly: config.hosted,")
    expect(source).toMatch(
      /if \(!writes\.ready\) return\n\s+chats\.setReadOnly\(!writes\.send\)\n\s+chats\.resume\(\)/,
    )
  })

  // Reply stays on the Mac, so on the hosted build a comment box with no answer to ride would take words that go nowhere
  test("a hosted update card or an answered card draws no comment box, and a card still waiting draws one that rides its answer", async () => {
    const source = await read("inbox.tsx")
    expect(source).toContain(
      'const noted = outcome === null && item.kind !== "update" && !secretAsk',
    )
    expect(source).toContain("!folded && answers && (noted || !config.hosted) ? (")
    expect(source).toContain(
      "answerItem(item, action, text, note.trim() || undefined, option, options)",
    )
  })

  test("the Inbox shows the line without a key, and a card holds its footer and note box only where its answer goes, never its Reply, read tick, Retry or bulk buttons", async () => {
    const source = await read("inbox.tsx")
    expect(source).toContain("{!writes.send && <ReadOnlyLine />}")
    expect(source).toContain("const answers = writes.answers(item)")
    expect(source).toContain("const footer = !answers ? (")
    expect(source).toContain("!folded && answers && (noted || !config.hosted) ? (")
    expect(source).toContain("if (!answers) return false")
    expect(source).toContain("{unread && !config.hosted ? (")
    expect(source).toMatch(/retryable\(item, now\) &&\s+!config\.hosted && \(/)
    expect(source).toMatch(
      /\{!config\.hosted && \(\n\s+<Hint\n\s+content=\{\n\s+held \?\?\n\s+\(secretAsk \|\| !chat/,
    )
    expect(source).toContain("{config.hosted ? null : clearing === 0 ? (")
    expect(source).toContain("{sweep && !config.hosted && (")
  })

  test("every other write button on the dashboard stands down on the hosted build", async () => {
    const writes: [string, string][] = [
      ["app-sidebar.tsx", "i === 0 && !muted && !config.hosted ? ("],
      ["app-sidebar.tsx", "!message || config.hosted) return null"],
      ["app-sidebar.tsx", "menu={\n          !config.hosted && (\n            <ContextMenuItem"],
      ["app-sidebar.tsx", ") : muted || config.hosted ? ("],
      ["app-sidebar.tsx", "{!config.hosted && (\n                <DropdownMenu>"],
      ["thread-view.tsx", "if (unread === 0 || config.hosted) return"],
      ["inbox.tsx", "unread && !paused && !config.hosted ? void settle(() => markRead([item.id]))"],
      ["inbox.tsx", ") : secretAsk && !config.hosted ? ("],
      [
        "inbox.tsx",
        "!isArchived(item) && !config.hosted && (\n            <RevealField id={item.id} />",
      ],
      ["inbox.tsx", '{!answers ? (\n          <p className="whitespace-pre-wrap">{draft}</p>'],
      [
        "inbox.tsx",
        ') : unread && !config.hosted ? (\n      <button type="button" className="text-left" onClick={read}>',
      ],
      [
        "../../plugins/changelog/view.tsx",
        "const mark = config.hosted ? null : seenMark(newest, seenAt)",
      ],
      ["dashboard-view.tsx", "{list.start && config.hosted && <ReadOnlyLine />}"],
      ["login-expired.tsx", '<ReadOnlyLine className="mt-2" />'],
      ["needs-you-card.tsx", "if (config.hosted) return sends ? ON_THE_MAC_LINE : READ_ONLY_LINE"],
      ["pages.tsx", "onDelete={config.hosted ? undefined : setDeleting}"],
      ["preview-pane.tsx", "{shown?.vibe && shown.path && !config.hosted && ("],
      ["preview-pane.tsx", "{!config.hosted && ("],
      ["preview-pane.tsx", "{config.hosted ? (\n                <ReadOnlyLine />"],
      ["worker-stream.tsx", "onAnswer={config.hosted ? null : item.need.onAnswer}"],
      ["worker-stream.tsx", "{failed && !config.hosted ? ("],
    ]
    for (const [file, line] of writes) expect(await read(file)).toContain(line)
  })

  test("Settings keeps Remote alone under the line on the hosted build, since pairing a browser is the one write it sends", async () => {
    const source = await read("../settings/settings-home.tsx")
    expect(source).toMatch(
      /\{allowed && config\.hosted \? \(\n\s+<div className="flex flex-col gap-6">\n\s+<ReadOnlyLine \/>\n\s+<Remote \/>\n\s+<\/div>\n\s+\) : allowed \? \(/,
    )
  })
})
