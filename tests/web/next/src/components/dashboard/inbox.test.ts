import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { InboxItem } from "../../../../../../api/hono/src/lib/dashboard/inbox"
import {
  type AskQuestion,
  type Choices,
  choicesOf,
  INSTALL_TEXT,
  PEER_INSTALL_TEXT,
  PEER_POLICY,
  PEER_RULE,
  questionsOf,
  ROOT_DIR,
  ROOT_STEPS,
} from "../../../../../../packages/config/src/inbox"
import { DashboardContext } from "../../../../../../web/next/src/components/dashboard/dashboard"
import {
  AskChoices,
  choicesKey,
  FOLDS_OPEN,
  Inbox,
  InboxCard,
  NewPill,
  picksKey,
  ShelfDismiss,
  ShelfLabel,
} from "../../../../../../web/next/src/components/dashboard/inbox"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
} from "../../../../../../web/next/src/components/ui/accordion"
import {
  Questionnaire,
  QuestionnaireItem,
} from "../../../../../../web/next/src/components/ui/questionnaire"
import { EMPTY_PICKS, readPicks, savePicks } from "../../../../../../web/next/src/lib/ask-picks"
import { cardDraftKey, readDrafts, saveDraft } from "../../../../../../web/next/src/lib/drafts"
import { INBOX_QUERY_KEY, SHELF_LABELS, type Shelf } from "../../../../../../web/next/src/lib/inbox"
import { tipsOf } from "../../tooltips"

// React and React Query resolve from the web app's own packages, which this directory cannot see; the calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}
const { QueryClient, QueryClientProvider } = (await import(
  Bun.resolveSync("@tanstack/react-query", web)
)) as { QueryClient: new () => unknown; QueryClientProvider: unknown }

const decision = {
  answer: null,
  createdAt: "2026-10-12T10:00:00.000Z",
  delivery: null,
  from: "ops",
  id: "id-41",
  kind: "decision",
  preview: { prs: [{ number: 270, title: "x" }], sha: "3f9a2c1", type: "ship" },
  readAt: null,
  ref: 41,
  status: "open",
  title: "Ship canary 3f9a2c1 to main?",
  updatedAt: "2026-10-12T10:00:00.000Z",
  version: 0,
} as InboxItem

// a card that folds by default renders folded unless the extras open it (defaultOpen) or place it on a shelf
const render = (
  paused: boolean,
  item: InboxItem = decision,
  updated = false,
  extra: { defaultOpen?: boolean; marked?: boolean; shelf?: Shelf } = {},
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        DashboardContext,
        { value: { workers: [] } as unknown as DashboardContext },
        createElement(InboxCard, {
          item,
          marked: false,
          now: Date.parse("2026-10-12T10:25:00.000Z"),
          paused,
          updated,
          ...extra,
        }),
      ),
    ),
  )
const opened = (item: InboxItem, shelf?: Shelf) =>
  render(false, item, false, { defaultOpen: true, ...(shelf && { shelf }) })

// the opening tag of the button whose words hold the label
const named = (html: string, label: string): string =>
  html
    .split("<button")
    .slice(1)
    // by its words, or by its name alone for an icon button (Later, Archive)
    .find((button) => {
      const own = button.split("</button>")[0]!
      return own.includes(`>${label}`) || own.split(">")[0]!.includes(`aria-label="${label}"`)
    })
    ?.split(">")[0] ?? ""

// A result line that names its poster (Queued for, Send unconfirmed) names it by its label, and the label keeps the raw session name on hover, as the sender label does. The dashboard here holds no live session, so the poster reads as plain text with its hover.
describe("a queued answer's poster", () => {
  const answered = {
    ...decision,
    answer: {
      at: "2026-10-12T10:05:00.000Z",
      choice: "approve",
      ackedAt: "2026-10-12T10:06:00.000Z",
    },
    delivery: {
      at: "2026-10-12T10:05:01.000Z",
      status: "delivered",
      via: "session",
    },
    status: "approved",
  } as InboxItem

  test("is shown by its label with the raw name on hover", () => {
    const html = render(false, {
      ...answered,
      delivery: { at: "2026-10-12T10:05:01.000Z", status: "queued" },
    } as InboxItem)
    expect(html).toContain("Queued for")
    expect(html).toContain('aria-description="ops"')
  })

  test("is the session that took the answer when the poster had ended, with its raw name on hover", () => {
    const html = render(false, {
      ...answered,
      delivery: { at: "2026-10-12T10:05:01.000Z", status: "queued", to: "dispatcher" },
    } as InboxItem)
    expect(html).toContain("Queued for")
    expect(html).toContain('aria-description="dispatcher"')
  })
})

describe("a multi-question ask (#1250)", () => {
  const multi = {
    ...decision,
    id: "id-48",
    preview: {
      questions: [
        {
          options: [{ description: "a day of soak", label: "staging" }, { label: "main" }],
          question: "Which base?",
          recommended: 0,
        },
        { options: [{ label: "now" }, { label: "later" }], question: "When?" },
      ],
      text: "Pick for each.",
      type: "ask",
    },
    ref: 48,
    title: "Port it, and when?",
  } as InboxItem

  test("picksKey changes when an in-place edit grows, shrinks, reorders or rewords the questions, so the card drops stale picks (#1250)", () => {
    const q = (question: string, labels: string[]): AskQuestion => ({
      options: labels.map((label, index) => ({
        go: true,
        index,
        label,
        letter: String.fromCharCode(65 + index),
      })),
      question,
    })
    const base = [q("Base?", ["staging", "main"]), q("When?", ["now", "later"])]
    const same = [q("Base?", ["staging", "main"]), q("When?", ["now", "later"])]
    expect(picksKey(base)).toBe(picksKey(same))
    expect(picksKey(base)).not.toBe(picksKey([...base, q("Who?", ["ops"])]))
    expect(picksKey(base)).not.toBe(picksKey([base[0]!]))
    expect(picksKey(base)).not.toBe(picksKey([base[1]!, base[0]!]))
    expect(picksKey(base)).not.toBe(picksKey([q("Base?", ["staging", "trunk"]), base[1]!]))
  })

  test("shows its words alone, with no On Approve line (#1250)", () => {
    const html = opened(multi)
    expect(html).toContain("Pick for each.")
    expect(html).not.toContain("On Approve")
  })

  test("shows its first question lettered, the recommended one badged in place, with Next and Send in the footer", () => {
    const html = opened(multi)
    expect(html).toContain("Which base?")
    expect(html).toContain("A. staging")
    expect(html).toContain("Recommended")
    expect(named(html, "Next")).not.toBe("")
    expect(named(html, "Send")).not.toBe("")
  })

  // once answered the stepper is gone and its result reads one pick per question and the note; the header sits outside every QuestionnaireItem, so the result renders as a plain description, not a QuestionnaireDescription, which throws there
  test("renders its answer as one pick per question and the note once answered", () => {
    const answered = {
      ...multi,
      answer: {
        at: "2026-10-12T10:05:00.000Z",
        choice: "approve",
        note: "Soak it.",
        options: [0, 1],
      },
      status: "approved",
    } as InboxItem
    const html = opened(answered)
    expect(html).toContain("A. staging · B. later")
    expect(html).toContain("You: ")
    expect(html).toContain("Soak it.")
    expect(html).not.toContain("When?")
  })
})

describe("a card that just moved under him", () => {
  test("pauses Send and Archive, still focusable and saying why, and dims its options", () => {
    const html = render(true)
    expect(html).toContain('aria-busy="true"')
    for (const label of ["Send", "Archive"]) {
      const tag = named(html, label)
      expect(tag).toContain('aria-disabled="true"')
      expect(tag).not.toContain("title=")
      // the first tooltip after the button's opening tag is its own
      expect(tipsOf(html.split(tag)[1] ?? "")[0]).toBe(
        "This item just moved: its buttons wake in a moment",
      )
      expect(tag).not.toMatch(/\sdisabled=""/)
    }
  })

  test("offers them as usual when it has not moved", () => {
    const html = render(false)
    expect(html).not.toContain('aria-busy="true"')
    expect(named(html, "Archive")).not.toContain("aria-disabled")
  })
})

describe("a card's change and colour: its updated time, and colour for its kind and state", () => {
  const sending = {
    ...decision,
    answer: { at: "2026-10-12T10:20:00.000Z", choice: "approve" },
    delivery: { status: "pending" },
    status: "approved",
    updatedAt: "2026-10-12T10:20:00.000Z",
  } as InboxItem

  test("an open decision wears its kind's colour on its icon", () => {
    const html = render(false)
    expect(html).toContain("remixicon size-3.5 text-warning")
    expect(html).not.toContain("updated ")
  })

  test("the band's one time reads posted, or updated once changed, then read on hover once read, before its tick", () => {
    const open = render(false)
    expect(open).toMatch(/>posted [^<]+</)
    expect(open).not.toContain(">read ")
    const changed = render(false, sending)
    expect(changed).toMatch(/>updated 5 min\. ago</)
    const read = render(false, { ...sending, readAt: "2026-10-12T10:24:00.000Z" } as InboxItem)
    expect(read).toMatch(/class="hidden group-hover\/time:inline">read 1 min\. ago</)
    expect(read).toContain("cursor-default select-none")
    expect(read.indexOf(">updated 5 min. ago<")).toBeLessThan(read.indexOf('aria-label="Read"'))
  })

  test("a changed item says when it last changed, the one time on its line, and reads Updated only when told it changed since his last look", () => {
    const html = render(false, sending, true)
    expect(html).toContain('dateTime="2026-10-12T10:20:00.000Z"')
    expect(html).toContain("updated 5 min. ago")
    expect(html).not.toContain(`dateTime="${sending.createdAt}"`)
    expect(html).toContain(">Updated</span>")
    expect(render(false, sending, false)).not.toContain(">Updated</span>")
  })

  test("a go being carried out draws the sidebar's blue spinner, turning only where motion is allowed, its result line blue", () => {
    const html = render(false, sending)
    expect(html).toContain("remixicon size-4 text-info motion-safe:animate-spin")
    expect(html).toContain("min-w-0 text-xs text-info")
  })

  test("an unread alert wears red on its icon, never its kind's green", () => {
    const alert = {
      ...decision,
      kind: "update",
      preview: { outcome: "alert" },
      status: "done",
      title: "Disk is nearly full",
    } as InboxItem
    const html = render(false, alert)
    expect(html).toContain("remixicon size-3.5 text-destructive")
    expect(html).not.toContain("text-success")
  })

  test("the kind icon rides the muted band, the state icon the title's first line, each in a LEAD box so the icons align and their words start level", () => {
    const lead = '<span class="flex h-lh w-4 shrink-0 items-center justify-center">'
    for (const html of [render(false), render(false, sending)]) {
      expect(html).toMatch(
        /<p class="bg-muted [^"]*px-\(--pane-x\)[^"]*"><span class="flex h-lh w-4 shrink-0 items-center justify-center me-0\.5"><svg [^>]*class="remixicon size-3\.5 text-warning"/,
      )
      expect(html.split(lead).find((part) => part.startsWith("<svg"))).toMatch(
        /^<svg [^>]*class="remixicon size-4 /,
      )
    }
  })

  test("each dispatcher's name takes its own tone in the band, blue for Alpha and purple for Bravo", () => {
    const from = (who: string) => render(false, { ...decision, from: who } as InboxItem)
    expect(from("dispatcher")).toMatch(/class="text-info"[^>]*>Alpha</)
    expect(from("dispatcher-2")).toMatch(/class="text-bravo"[^>]*>Bravo</)
    expect(from("alpha")).not.toContain('text-info"')
  })

  test("a card takes focus from script alone, so taking the pill can hand focus to it", () => {
    const card =
      render(false).split('role="listitem"')[0]!.split("<div").at(-1)! +
      render(false).split('role="listitem"')[1]!.split(">")[0]!
    expect(card).toContain('tabindex="-1"')
  })

  test("an open decision draws the sidebar's orange eye beside its title", () => {
    expect(render(false)).toContain("remixicon size-4 text-caution")
  })

  // #882: a folded row keeps its choices
  test("an answered card folds to its result, keeping Done, Dismiss and its chevron, and opened, they sit in the footer row left of Reply, its result above the row", () => {
    const folded = render(false, sending)
    expect(folded).toContain("Approve · Ship 3f9a2c1 to main")
    for (const label of ["Done", "Dismiss", "Expand"]) expect(named(folded, label)).not.toBe("")
    const html = opened(sending)
    const dismiss = named(html, "Dismiss")
    expect(dismiss).not.toBe("")
    const reply = html.indexOf('aria-label="Reply to #i41"')
    expect(reply).toBeGreaterThan(-1)
    expect(html.indexOf("Approve · Ship 3f9a2c1 to main")).toBeLessThan(html.indexOf(dismiss))
    expect(html.indexOf(dismiss)).toBeLessThan(reply)
  })
})

describe("one action where two overlapped, and Draft where the app has a draft API", () => {
  const update = {
    ...decision,
    kind: "update",
    preview: { outcome: "merged" },
    status: "done",
  } as InboxItem
  const draft = (link: string) =>
    ({
      ...decision,
      kind: "draft",
      preview: { link, text: "hi", to: "Merritt DM" },
    }) as InboxItem

  test("a card's answer names the updatedAt it showed, so the API refuses one to words its poster edited since", () => {
    const card = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const client = readFileSync(join(web, "src/lib/inbox.ts"), "utf8")
    expect(card).toContain(
      "answerItem(item, action, text, note.trim() || undefined, option, options)",
    )
    expect(client).toContain("json: { action, note, option, options, seen: updatedAt, text }")
  })

  test("an unread update's line ends in a single tick, Mark as read; once read, a muted double tick named Read, folded, its row keeping Dismiss (#882)", () => {
    const html = render(false, update)
    expect(named(html, "Dismiss")).not.toBe("")
    expect(named(html, "Mark as read")).not.toBe("")
    const seen = render(false, { ...update, readAt: "2026-10-12T10:05:00.000Z" })
    expect(named(seen, "Mark as read")).toBe("")
    expect(seen).toContain('aria-label="Read"')
    expect(named(seen, "Expand")).not.toBe("")
    expect(named(seen, "Dismiss")).not.toBe("")
  })

  test("Dismiss is an icon button, named in its label", () => {
    const dismiss = named(render(false, update), "Dismiss")
    expect(dismiss.split(">")[0]).toContain('aria-label="Dismiss"')
    expect(dismiss.split("</button>")[0]).not.toContain(">Dismiss")
  })

  test("a Slack draft offers Send, Draft and Discard", () => {
    const html = render(false, draft("https://app.slack.com/client/T0000000000/D0MADEUP11"))
    expect(named(html, "Send")).not.toBe("")
    expect(named(html, "Draft")).not.toBe("")
    expect(named(html, "Discard")).not.toBe("")
  })

  test("a draft shows its before and after under its words, as an ask does (PG-501)", () => {
    const shots = [
      {
        id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png",
        kind: "image",
        label: "before",
        name: "b.png",
      },
      {
        id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a2.png",
        kind: "image",
        label: "after",
        name: "a.png",
      },
    ]
    const plain = draft("https://app.slack.com/client/T0000000000/C0MADEUP01")
    const shown = render(false, {
      ...plain,
      preview: { ...plain.preview, attachments: shots },
    } as InboxItem)
    const ask = render(false, {
      ...decision,
      preview: { attachments: shots, text: "hi", type: "ask" },
    } as InboxItem)
    const thumbs = (html: string) => html.split('data-slot="attachment-thumbs"').length - 1
    expect(thumbs(shown)).toBe(1)
    expect(thumbs(shown)).toBe(thumbs(ask))
    expect(shown.indexOf('data-slot="attachment-thumbs"')).toBeGreaterThan(
      shown.indexOf("<textarea"),
    )
    expect(thumbs(render(false, plain))).toBe(0)
  })

  test("a Linear comment offers no Draft, since Linear's API creates none", () => {
    const html = render(false, draft("https://linear.app/acme/issue/MADEDUNE-1/x"))
    expect(named(html, "Send")).not.toBe("")
    expect(named(html, "Draft")).toBe("")
  })
})

// A dashboard user, 23 Oct: "When I'm done with it, there's no way to expand that window back up or even edit it".
describe("a card a chat reply collapsed", () => {
  const replied = (ackedAt?: string) =>
    ({
      ...decision,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "replied", ...(ackedAt && { ackedAt }) },
      kind: "draft",
      preview: {
        link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
        text: "hi",
        to: "Merritt DM",
      },
    }) as InboxItem
  const toggle = (html: string) =>
    html
      .split("<button")
      .slice(1)
      .find((button) => /aria-label="(Expand|Collapse)"/.test(button))
      ?.split(">")[0] ?? ""

  test("reads as being worked on, folded: its blue light, no Send, Draft, Discard or Later, and Expand to open it, on E too", () => {
    const html = render(false, replied())
    expect(html).toContain("You replied")
    expect(html).toContain("animate-spin")
    for (const label of ["Send", "Draft", "Discard", "Later"]) expect(named(html, label)).toBe("")
    expect(toggle(html)).toContain('aria-expanded="false"')
    expect(toggle(html)).toContain('aria-keyshortcuts="E"')
  })

  test("an open card's chevron reads Collapse, and a reply its poster closed folds behind it as any card needing no answer does", () => {
    expect(toggle(render(false, { ...replied(), answer: null } as InboxItem))).toContain(
      'aria-expanded="true"',
    )
    expect(toggle(render(false, replied("2026-10-12T10:06:00.000Z")))).toContain(
      'aria-expanded="false"',
    )
  })
})

// PG-644: a card folds to its band, title and result unless it needs an answer now; PG-654: a draft takes Archive as an ask does.
describe("a card folds by priority, the ones needing an answer staying open", () => {
  const read = {
    ...decision,
    kind: "update",
    preview: { outcome: "merged", text: "The changelog now reads as text." },
    readAt: "2026-10-12T10:05:00.000Z",
    status: "done",
    title: "Merged: changelog entries read as text",
  } as InboxItem
  const draft = {
    ...decision,
    kind: "draft",
    preview: {
      link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
      text: "hi",
      to: "Merritt DM",
    },
  } as InboxItem
  const snoozed = {
    ...decision,
    answer: { at: "2026-10-12T10:05:00.000Z", snoozedUntil: "2026-10-12T11:00:00.000Z" },
  } as InboxItem

  // #882: every card shows the expand chevron
  test("an open decision shows whole, its chevron reading Collapse", () => {
    const html = render(false)
    expect(named(html, "Collapse")).toContain('aria-expanded="true"')
    expect(html).toContain(">Approve</span>")
  })

  test("a read update folds to its title, keeping Done, Later, Archive and Dismiss, and Expand opens it to its words", () => {
    const html = render(false, read)
    expect(html).toContain("Merged: changelog entries read as text")
    expect(html).not.toContain("The changelog now reads as text.")
    expect(named(html, "Expand")).toContain('aria-expanded="false"')
    expect(named(html, "Expand")).toContain('aria-keyshortcuts="E"')
    for (const label of ["Done", "Later", "Archive", "Dismiss"])
      expect(named(html, label)).not.toBe("")
    const open = opened(read)
    expect(open).toContain("The changelog now reads as text.")
    expect(named(open, "Collapse")).toContain('aria-expanded="true"')
    expect(named(open, "Dismiss")).not.toBe("")
  })

  test("an ask put away with Later folds until its time, its row keeping Later, Archive and Dismiss, its options in its body", () => {
    const folded = render(false, snoozed, false, { shelf: "snoozed" })
    expect(named(folded, "Expand")).not.toBe("")
    for (const label of ["Later", "Archive", "Dismiss"]) expect(named(folded, label)).not.toBe("")
    expect(folded).not.toContain(">Approve</span>")
  })

  test("an open draft offers Archive, Later and Dismiss beside Send, and its folded row leaves Send to its words", () => {
    const html = render(false, draft)
    expect(named(html, "Collapse")).not.toBe("")
    for (const label of ["Archive", "Send", "Later", "Dismiss"])
      expect(named(html, label)).not.toBe("")
  })
})

// #882: Seen, Done, Later, Archive and Dismiss on every card, each by its state
describe("a card's verbs", () => {
  const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
  const archived = {
    ...decision,
    answer: { archivedAt: "2026-10-12T10:05:00.000Z" },
  } as unknown as InboxItem
  const answered = {
    ...decision,
    answer: {
      at: "2026-10-12T10:05:00.000Z",
      choice: "approve",
      dismissedAt: "2026-10-12T10:06:00.000Z",
    },
    readAt: "2026-10-12T10:05:00.000Z",
    status: "approved",
  } as InboxItem

  test("Done sends the card to Done, Archive and Dismiss answer through the card's own route, and Move back through unarchive", () => {
    const done = source.slice(
      source.indexOf('buttons.includes("done")'),
      source.indexOf('buttons.includes("later")'),
    )
    // a card's own Done tells its update's poster; the Done shelf's bulk below types nothing
    expect(done).toContain("void settle(() => dismissItems([item.id], true))")
    expect(source).toContain('() => void onAnswer("archive"),')
    expect(source).toContain('() => void onAnswer("dismiss"),')
    expect(source).toContain('void onAnswer("unarchive")')
  })

  test("a waiting card's Dismiss says its poster is told it is set aside, and an answered one's that it is marked dismissed", () => {
    expect(tipsOf(render(false))).toContain(
      "Dismiss: it goes to Done, and its poster is told it is set aside",
    )
    expect(
      tipsOf(opened({ ...answered, answer: { at: "x", choice: "approve" } } as InboxItem)),
    ).toContain("Dismiss: it goes to Done, marked dismissed")
  })

  test("an archived card offers Later, Move back and Dismiss, and no Archive or Done", () => {
    const html = opened(archived, "archived")
    for (const label of ["Later", "Move back", "Dismiss"]) expect(named(html, label)).not.toBe("")
    for (const label of ["Archive", "Done"]) expect(named(html, label)).toBe("")
  })

  test("a card on Done offers Dismiss until dismissed, then none", () => {
    expect(named(opened(answered, "done"), "Dismiss")).not.toBe("")
    const dismissed = {
      ...answered,
      answer: { ...(answered.answer as object), dismissed: true },
    } as InboxItem
    expect(named(opened(dismissed, "done"), "Dismiss")).toBe("")
  })

  test("the Archive shelf holds what the API lists as archived, beside the old set-aside rows", () => {
    expect(source).toContain(
      "const archived = [...(data?.archived ?? []), ...setAside].sort((a, b) => b.ref - a.ref)",
    )
  })
})

describe("a decision's labelled Approve and Deny options", () => {
  const labelled = {
    ...decision,
    id: "id-90",
    preview: {
      approve: "The port ships to staging and main.",
      deny: "The port waits; nothing moves.",
      text: "Port the fix to staging and main.",
      type: "ask",
    },
  } as InboxItem
  const unlabelled = {
    ...decision,
    id: "id-91",
    preview: { text: "Port the fix to staging and main.", type: "ask" },
  } as InboxItem

  test("a labelled ask renders each option with what it does, on the Questionnaire, and the On Approve line goes", () => {
    const html = render(false, labelled)
    expect(html).toContain('data-slot="questionnaire-choice"')
    expect(html).toContain("The port ships to staging and main.")
    expect(html).toContain("The port waits; nothing moves.")
    expect(html).toContain(">Approve</span>")
    expect(html).toContain(">Deny</span>")
    expect(html).not.toContain("On Approve,")
  })

  test("a labelled ask shows its text in the card's description, above its choices", () => {
    const html = render(false, labelled)
    const described = html.split('data-slot="questionnaire-description"')[1] ?? ""
    expect(described.split('data-slot="questionnaire-choice"')[0]).toContain(
      "Port the fix to staging and main.",
    )
  })

  test("an ask with no labels keeps its On Approve line, above a bare Approve and Deny", () => {
    const html = render(false, unlabelled)
    expect(html).toContain("On Approve,")
    expect(html).toContain("does this:")
    expect(html).toContain('data-slot="questionnaire-choice"')
    expect(html).toContain(">Approve</span>")
    expect(html).toContain(">Deny</span>")
  })

  test("a lettered ask shows A to E with their descriptions and number badges, then None of these (#873)", () => {
    const html = render(false, {
      ...unlabelled,
      preview: {
        options: [
          { description: "Staging first, a day of soak", label: "Port to staging, then main" },
          { label: "Hotfix main" },
        ],
        text: "Which way does the fix go?",
        type: "ask",
      },
    } as InboxItem)
    for (const word of ["A. Port to staging, then main", "B. Hotfix main", "C. None of these"])
      expect(html).toContain(`>${word}</span>`)
    expect(html).toContain("Staging first, a day of soak")
    expect(html).not.toContain(">Approve</span>")
    expect(html).not.toContain("On Approve,")
    expect(html.match(/data-slot="questionnaire-choice"/g)).toHaveLength(3)
  })

  test("every decision but a secret shows its rows, a typed one by its default labels (#873)", () => {
    const html = render(false)
    expect(html).toContain("Ship 3f9a2c1 to main")
    expect(html).toContain("Hold the ship")
    expect(html.match(/data-slot="questionnaire-choice"/g)).toHaveLength(2)
  })

  test("its Archive button says why on hover while the card is paused, as its siblings do", () => {
    const tag = named(render(true, labelled), "Archive")
    expect(tag).not.toBe("")
    expect(tipsOf(render(true, labelled).split(tag)[1] ?? "")[0]).toBe(
      "This item just moved: its buttons wake in a moment",
    )
  })
})

// Questionnaire counts a disabled choice as no answer, so disabling the picked side on a busy card (its answer on its way, or just moved under him) read as unanswered after Send's own check, and both choices drew red with aria-invalid until the card settled.
describe("a decision's choices while the card is busy", () => {
  const labeled: Choices = choicesOf({ approve: "Ship it", deny: "Hold it", type: "ask" })!
  const choices = (state: { busy: boolean; paused: boolean }) =>
    renderToStaticMarkup(
      createElement(
        Questionnaire,
        null,
        createElement(
          QuestionnaireItem,
          { name: "question" },
          createElement(AskChoices, {
            ...state,
            choices: labeled,
            pick: 0,
            setPick: () => undefined,
          }),
        ),
      ),
    )
  const radios = (html: string) => html.match(/<input[^>]*>/g) ?? []
  const group = (html: string) =>
    html.match(/<[^>]*data-slot="questionnaire-choices"[^>]*>/)?.[0] ?? ""
  // AskChoices holds no hooks, so it is called as a function and each choice's change fired as a click or a key would fire it
  type Choice = { props: { children: { props: { onChange: () => void } } } }
  const picked = (busy: boolean) => {
    const picks: number[] = []
    const element = AskChoices({
      busy,
      choices: labeled,
      paused: false,
      pick: 0,
      setPick: (row) => picks.push(row),
    })
    for (const choice of element.props.children as Choice[]) choice.props.children.props.onChange()
    return picks
  }

  for (const [state, why] of [
    [{ busy: true, paused: false }, "while its answer is on its way"],
    [{ busy: true, paused: true }, "on a card that just moved under him"],
  ] as const) {
    test(`stay enabled ${why}, so the picked side still counts, dimmed under a busy group that takes no pointer`, () => {
      const html = choices(state)
      expect(radios(html)).toHaveLength(2)
      for (const radio of radios(html)) expect(radio).not.toMatch(/\sdisabled=""/)
      expect(group(html)).toContain('aria-busy="true"')
      expect(group(html)).toContain("pointer-events-none")
    })
  }

  test("a click or a key on a busy card leaves the pick as it was, and takes either side on an idle one", () => {
    expect(picked(true)).toEqual([])
    expect(picked(false)).toEqual([0, 1])
  })

  test("an idle card's group reads neither busy nor dimmed", () => {
    const html = choices({ busy: false, paused: false })
    expect(group(html)).not.toBe("")
    expect(group(html)).not.toContain("aria-busy")
    expect(group(html)).not.toContain("opacity-50")
  })
})

// The picker only opens to a click, which this server-render harness cannot replay, so its closes are pinned on the component's own source.
describe("a picked time never opens a row nothing closes", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/inbox.tsx"),
    "utf8",
  )
  const picker = source.slice(
    source.indexOf('{picking && buttons.includes("later") && ('),
    source.indexOf("{error && <p"),
  )
  const schedule = source.slice(
    source.indexOf("function Schedule"),
    source.indexOf("function InboxCard"),
  )

  test("the row closes three ways: Escape on the input, Set (which schedules first), and Cancel", () => {
    expect([...picker.matchAll(/closePicking/g)]).toHaveLength(3)
    expect(picker).toContain('if (event.key === "Escape") closePicking()')
    expect(picker).toContain("onClick={closePicking}")
    expect(picker).toContain("Cancel")
  })

  test("Schedule takes the picking state through setPicking alone, and renders the menu directly", () => {
    expect(schedule).toContain("setPicking: (picking: boolean) => void")
    expect(schedule).not.toContain("<>")
    expect(schedule).not.toContain("</>")
  })
})

// Schedule's row once had no render test: breaking its guard left every test green. These two rows hold it from both sides.
describe("Schedule's row", () => {
  test("an open ask offers Later", () => {
    expect(named(render(false), "Later")).not.toBe("")
  })

  test("a card's Mark as read only marks it seen, answering and dismissing nothing, and an ask once read keeps its buttons but the ✓✓", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const at = source.indexOf('aria-label="Mark as read"')
    const click = source.slice(at, source.indexOf("</button>", at))
    expect(click).toContain("onClick={onRead}")
    expect(source).toContain("onRead={() => read()}")
    expect(source).toMatch(
      /const read = \(\) =>\s+unread && !paused && !config\.hosted \? void settle\(\(\) => markRead\(\[item\.id\]\)\) : undefined/,
    )
    expect(source).not.toContain('answerItem(item.id, "read"')
    expect(source).not.toContain('answerItem(item, "read"')
    const seen = render(false, { ...decision, readAt: "2026-10-12T10:05:00.000Z" } as InboxItem)
    expect(named(seen, "Mark as read")).toBe("")
    expect(seen).toContain('aria-label="Read"')
    for (const label of ["Send", "Archive", "Later"]) expect(named(seen, label)).not.toBe("")
    for (const side of ["Approve", "Deny"]) expect(seen).toContain(`>${side}</span>`)
  })

  test("the comment box reads Add an optional comment, named Comment, the same gap-2 below the choices as between them", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    expect(source).toContain(
      '<CardContent className="mt-[calc(--spacing(2)-var(--card-spacing))]">',
    )
    const html = render(false)
    expect(html).toContain('placeholder="Add an optional comment"')
    expect(html).toContain('aria-label="Comment"')
  })

  // a focused box that turns disabled drops focus to the page, so words dictated or typed while a card above it leaves land nowhere
  test("the comment box stays enabled on a card that just moved under him, and only reads read-only while its answer is on its way", () => {
    const box = (html: string) => html.match(/<textarea[^>]*aria-label="Comment"[^>]*>/)?.[0] ?? ""
    expect(box(render(true))).not.toBe("")
    expect(box(render(true))).not.toMatch(/\sdisabled=""/)
    expect(box(render(false))).not.toMatch(/\sdisabled=""|\sreadonly=""/i)
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    expect(source).toMatch(/<NoteBox[^>]*readOnly=\{pending\}/)
    expect(source).toMatch(/placeholder="Paste the value"\s+readOnly=\{pending\}/)
  })

  // the browser's own paste reads the clipboard again at the insert, which a dictation app may have put back by then, so the box inserts the text its paste event carried, as the composer does
  test("the comment box lands a paste as the text its event carried, through insertPaste", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const box = source.slice(
      source.indexOf("function NoteBox("),
      source.indexOf("// Taking what waits behind the pill"),
    )
    expect(box).toContain("onPaste={(event) => void insertPaste(event)}")
  })

  test("an unread ask keeps its light and draws no unread dot, which stays an update's", () => {
    expect(render(false)).not.toContain("bg-primary size-2 rounded-full")
    expect(
      render(false, {
        ...decision,
        kind: "update",
        preview: { outcome: "merged" },
        status: "done",
      } as InboxItem),
    ).toContain("bg-primary size-2 rounded-full")
  })

  test("an open decision's Mark as read is the single tick on its kind line, out of the footer, where Later leads Archive, then Dismiss, as #882's table reads", () => {
    const html = render(false)
    const read = named(html, "Mark as read")
    expect(read).not.toBe("")
    const footer = html.indexOf("ml-auto flex shrink-0 gap-2")
    expect(html.indexOf(read)).toBeLessThan(footer)
    expect(html.slice(footer)).not.toContain('aria-label="Mark as read"')
    expect(html.indexOf(named(html, "Later"))).toBeLessThan(html.indexOf(named(html, "Archive")))
    expect(html.indexOf(named(html, "Archive"))).toBeLessThan(html.indexOf(named(html, "Dismiss")))
  })

  test("an answered one does not, and keeps Seen in its band while unread", () => {
    const answered = {
      ...decision,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve" },
      status: "approved",
    } as InboxItem
    const html = render(false, answered)
    expect(named(html, "Later")).toBe("")
    expect(html.slice(html.indexOf("ml-auto flex shrink-0 gap-2"))).not.toContain(
      'aria-label="Mark as read"',
    )
    expect(named(html, "Mark as read")).not.toBe("")
  })
})

// A settled card's result once sat in the footer row between Dismiss and Reply, and a long line wrapped between the two buttons: the result reads above the row now, and Dismiss stands directly left of Reply in it.
describe("a settled card's footer", () => {
  const settled = {
    ...decision,
    answer: {
      at: "2026-10-12T10:05:00.000Z",
      by: "ops",
      choice: "settled",
      note: "Dismissed by the poster once the restart went out and the task moved to the runner that took the rename, so this item's whole story runs long enough to wrap over two lines at any width.",
    },
    status: "done",
  } as InboxItem

  test("the result sits above the footer row and Dismiss stands in the row, left of Reply", () => {
    const html = opened(settled)
    const resultAt = html.indexOf("Decided by")
    const footerAt = html.indexOf('data-slot="card-footer"')
    const dismissAt = html.indexOf(named(html, "Dismiss"))
    const replyAt = html.indexOf('aria-label="Reply to #i41"')
    expect(resultAt).toBeGreaterThan(-1)
    expect(footerAt).toBeGreaterThan(-1)
    expect(dismissAt).toBeGreaterThan(-1)
    expect(replyAt).toBeGreaterThan(-1)
    expect(resultAt, "the result reads above the footer row").toBeLessThan(footerAt)
    expect(dismissAt, "Dismiss sits in the footer row").toBeGreaterThan(footerAt)
    expect(dismissAt, "Dismiss stands left of Reply").toBeLessThan(replyAt)
    expect(
      html.slice(dismissAt, replyAt).indexOf("<p "),
      "no result line between the two buttons",
    ).toBe(-1)
  })

  test("the poster's settle reason reads once, in the result, never as his comment, since he never wrote it", () => {
    const html = render(false, settled)
    expect(html).not.toContain("You: ")
    const approved = {
      ...decision,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve", note: "Ship it after lunch." },
      status: "done",
    } as InboxItem
    expect(render(false, approved)).toContain("You: Ship it after lunch.")
  })
})

// Dismiss belongs in Reply's row (#i510): it moves into the right-hand group, directly left of Reply, out of the footer's left end.
describe("a settled card's right-hand group", () => {
  const settled = {
    ...decision,
    answer: {
      at: "2026-10-12T10:05:00.000Z",
      by: "ops",
      choice: "settled",
      note: "Settled by the poster, so the card offers Dismiss and Reply alone.",
    },
    status: "done",
  } as InboxItem

  test("Dismiss stands inside Reply's own group, before it, the fold's toggle alone between them", () => {
    const html = opened(settled)
    const groupAt = html.indexOf("ml-auto")
    const dismissAt = html.indexOf(named(html, "Dismiss"))
    const replyAt = html.indexOf('aria-label="Reply to #i41"')
    expect(groupAt).toBeGreaterThan(-1)
    expect(dismissAt).toBeGreaterThan(-1)
    expect(replyAt).toBeGreaterThan(-1)
    expect(dismissAt, "Dismiss sits after the group opens, inside it").toBeGreaterThan(groupAt)
    expect(dismissAt, "Dismiss stands left of Reply").toBeLessThan(replyAt)
    const between = html.slice(dismissAt, replyAt)
    expect(between.split("<button").length - 1, "Collapse, then Reply's own").toBe(2)
    expect(between).toContain('aria-label="Collapse"')
  })
})

// ib-7: one comment box on every open card, and Reply on every card, folded rows included, in place of Chat about it.
describe("the comment box and Reply on every card", () => {
  const answered = {
    ...decision,
    answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve" },
    delivery: { at: "2026-10-12T10:05:01.000Z", status: "delivered", to: "ops", via: "session" },
    status: "approved",
  } as InboxItem
  const update = {
    ...decision,
    kind: "update",
    preview: { outcome: "merged" },
    readAt: "2026-10-12T10:01:00.000Z",
    title: "Merged #270",
  } as InboxItem
  const secret = {
    ...decision,
    preview: { key: "API_KEY", sink: { item: "slack", type: "keychain" }, type: "secret" },
    title: "Paste the Slack token",
  } as InboxItem
  const cards = { answered, open: decision, secret, update }

  test("every open card shows the box: an open ask, an answered one, an update and a secret ask", () => {
    for (const [name, item] of Object.entries(cards)) {
      expect(opened(item), name).toContain('aria-label="Comment"')
    }
  })

  test("a secret ask's value field stays enabled on a card that just moved under him, so a paste in that second lands", () => {
    const field = (html: string) =>
      html.match(/<input[^>]*placeholder="Paste the value"[^>]*>/)?.[0] ?? ""
    const paused = render(true, secret, false, { defaultOpen: true })
    expect(field(paused)).not.toBe("")
    expect(field(paused)).not.toMatch(/\sdisabled=""|\sreadonly=""/i)
    expect(field(paused)).toContain('type="password"')
  })

  test("the box reads optional where it rides an answer as its note, and plain where Reply alone sends it", () => {
    expect(opened(decision)).toContain('placeholder="Add an optional comment"')
    for (const item of [answered, update]) {
      expect(opened(item)).toContain('placeholder="Add a comment"')
    }
  })

  // #2038: a secret ask's or a reveal card's empty-box Reply only focuses its own box, so the box and a muted line say how Reply works there
  const reveal = {
    ...decision,
    preview: { service: "playground-demo", type: "reveal", why: "To check the demo token" },
    title: "Show the demo token",
  } as InboxItem
  const HINT = "Type your note in the box above, then press Reply. The token goes in its own field"

  test("a secret ask's and a reveal card's box says to type a note, then press Reply; every other card keeps its own (#2038)", () => {
    for (const item of [secret, reveal]) {
      expect(opened(item), item.title).toContain(
        'placeholder="Type a note to Playground, then press Reply"',
      )
      expect(opened(item), item.title).not.toContain(HINT)
    }
    expect(opened(decision)).toContain('placeholder="Add an optional comment"')
    for (const item of [answered, update]) {
      expect(opened(item)).toContain('placeholder="Add a comment"')
      expect(opened(item)).not.toContain("then press Reply")
    }
  })

  test("an empty-box Reply on a secret ask or a reveal card shows one muted line under the box, gone for good once the box holds text (#2038)", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const reply = source.slice(source.indexOf("const onReply = () => {"))
    // set by an empty box's Reply alone, and cleared once the box holds text, so a sent note or a cleared box never brings it back
    expect(reply).toContain('if (keepsReply && text === "") setHinted(true)')
    const box = source.slice(source.indexOf("const noteContent ="))
    expect(box).toContain('if (event.target.value.trim() !== "") setHinted(false)')
    expect(box).toContain("{hinted && (")
    const line = box.slice(box.indexOf("{hinted && ("))
    expect(line).toMatch(
      /^[^}]*<p className="text-muted-foreground mt-2 text-xs">\s+Type your note/,
    )
    expect(line).toContain(HINT)
  })

  test("every card offers Reply, folded or open, and none offers Chat about it", () => {
    for (const [name, item] of Object.entries(cards)) {
      for (const html of [render(false, item), opened(item)]) {
        expect(named(html, "Reply to #i41"), name).not.toBe("")
        expect(html).not.toContain("Chat about")
      }
    }
    expect(render(false, update)).not.toContain('aria-label="Comment"')
  })

  test("Reply with an empty box hands the card's ref to Playground's composer, which the aside brings forward, focused in the click's frame (#1045)", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const reply = source.slice(source.indexOf("const onReply = () => {"))
    // the hand goes only while Playground's session is live, the one whose composer the dashboard mounts, else the card's own box opens as before
    expect(source).toContain("const chat = allowed ? dispatcherOf(workers, dispatcher) : null")
    expect(reply).toContain("replyRoute({ chat: chat !== null, folded, secret: keepsReply, text })")
    expect(reply).toContain('if (route === "composer" && chat) {')
    expect(reply).toContain("flushSync(() => outbox.reply(chat.name, item.ref))")
    expect(reply).toContain("document.getElementById(COMPOSER_ID)?.focus()")
    // the hand goes to the primary dispatcher's box alone, the page's own chat or the aside's, and the aside shows that chat on every hand, so it never lands in a box out of sight
    const aside = readFileSync(join(web, "src/components/dashboard/dashboard-aside.tsx"), "utf8")
    expect(aside).toContain("const handed = outbox.draft")
    expect(aside).toContain("else showChat()")
    const composer = readFileSync(join(web, "src/components/dashboard/composer.tsx"), "utf8")
    expect(composer).toContain(
      'const text = takeHanded(form.getFieldValue("text"), draft, worker.name, taken.current)',
    )
    expect(composer).toContain("if (threadId) return")
  })

  test("Reply opens a folded card to its box, focused in the click's frame, and sends the words alone, a secret's guarded by its value", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    const reply = source.slice(source.indexOf("const onReply = () => {"))
    expect(reply).toContain("flushSync(() => setToggled(true))")
    expect(reply).toContain("document.getElementById(commentId)?.focus()")
    expect(reply).toContain("secretAsk ? commentRefused(note, secret) : null")
    expect(reply).toContain("replyItem(item.id, text)")
    expect(source).not.toContain("setReply")
  })
})

// The Inbox is one accordion: the open items' row, then a row for each shelf.
describe("the Inbox as one accordion: the open items, then Later, Archive and Done", () => {
  const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
  const shelf = (count: number) =>
    renderToStaticMarkup(
      createElement(
        Accordion,
        { multiple: true },
        createElement(
          AccordionItem,
          { disabled: count === 0, value: "Later" },
          createElement(
            AccordionTrigger,
            null,
            createElement(ShelfLabel, { count, icon: () => null, label: "Later" }),
          ),
        ),
      ),
    )

  test("a shelf's row reads its name, then its count as a mono outline label", () => {
    const html = shelf(3)
    const badge = /<span [^>]*data-slot="badge"[^>]*>3<\/span>/.exec(html)?.[0] ?? ""
    expect(badge).toContain('data-variant="outline"')
    expect(badge).toContain("font-mono")
    expect(html.indexOf("Later")).toBeLessThan(html.indexOf(badge))
  })

  test("an empty shelf's row is grayed and shut, and one with items opens", () => {
    const trigger = (html: string) =>
      /<button [^>]*data-slot="accordion-trigger"[^>]*>/.exec(html)?.[0] ?? ""
    expect(trigger(shelf(0))).toContain('disabled=""')
    expect(trigger(shelf(2))).not.toContain('disabled=""')
  })

  test("the rows run open items, In progress, Later, Archive, Done, and the ones put away with Later come from the API's own list, never items", () => {
    expect(source).toContain('<AccordionItem value="open" disabled={rows.length === 0}')
    const order = ['["progress"', '["snoozed"', '["archived"', '["done"'].map((row) =>
      source.indexOf(row),
    )
    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(source).toContain("const snoozed = data?.snoozed ?? []")
    expect(source).toContain("const summary = inboxSummary(shown)")
  })

  test("the open items start open and the shelves shut, and taking the pill or a link to a folded card opens the list", () => {
    expect(FOLDS_OPEN).toEqual({ open: true })
    expect(source).toContain("const [listOpen, setListOpen] = useState<boolean>(FOLDS_OPEN.open)")
    expect(source).toContain("const [shelvesOpen, setShelvesOpen] = useState<string[]>([])")
    expect(source).toContain('...(listOpen && rows.length > 0 ? ["open"] : []),')
    expect(source).toMatch(/const take = \(\) => \{\n\s+setListOpen\(true\)/)
    expect(source).toMatch(/if \(!listOpen && rows\.some\([^\n]*\) \{\n\s+setListOpen\(true\)/)
  })

  test("an empty row is never open: with no items, no row shows on a blank panel, and the open list keeps his choice for when items come", () => {
    expect(source).toContain('...(listOpen && rows.length > 0 ? ["open"] : []),')
    expect(source).toContain(
      '...shelvesOpen.filter((key) => key === "Preview" || (shelfSizes[key] ?? 0) > 0),',
    )
    expect(source).toContain('if (rows.length > 0) setListOpen(value.includes("open"))')
  })

  test("a card set aside before Archive kept items open is the same card on Archive, opened to Move back and Dismiss, and the Archive row empties in one click", () => {
    const archived = {
      ...decision,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "clear" },
      status: "cleared",
    } as InboxItem
    const html = opened(archived, "archived")
    expect(html).toContain("On Approve, main moves to")
    expect(html).not.toContain("bg-muted/40")
    expect(named(html, "Move back")).not.toBe("")
    expect(named(html, "Dismiss")).not.toBe("")
    for (const label of ["Archive", "Done", "Later"]) expect(named(html, label)).toBe("")
    expect(source).toContain("shelf={place}")
    // Move back is his own click, so the card takes the list's top as it arrives, never behind the new-updates pill
    expect(source).toContain("onBack={() => setBack(item.id)}")
    expect(source).toContain("if (back !== null && held.some((item) => item.id === back)) {")
    expect(source).toContain("setOrder([back, ...rowIds])")
    // the Archive shelf's one click is each card's own Dismiss, a waiting ask included; Done's marks read and tells no poster
    const bulkDismiss = source.slice(source.indexOf("onDismiss={(ids) =>"))
    expect(bulkDismiss).toMatch(
      /sweep\.each\s+\? dismissEach\(shelf\.filter\(\(item\) => ids\.includes\(item\.id\)\)\)\s+: dismissItems\(ids\),/,
    )
  })

  test("Done's ✓✓ marks every item in it read, and is gone once all are", () => {
    const button = (ids: string[]) =>
      /<button[^>]*>/.exec(
        renderToStaticMarkup(
          createElement(ShelfDismiss, {
            disabled: false,
            ids,
            label: "Mark all in Done as read",
            onDismiss: () => {},
          }),
        ),
      )?.[0] ?? ""
    expect(button(["a", "b"])).toContain('aria-label="Mark all in Done as read"')
    expect(button(["a", "b"])).not.toContain(' disabled=""')
    expect(button([])).toBe("")
  })

  test("an empty shelf's row is disabled", () => {
    expect(source).toContain("disabled={shelf.length === 0}")
  })

  test("every shelf counts what it holds, Done its history too, and Done tells a screen reader how many are unread", () => {
    const html = renderToStaticMarkup(
      createElement(ShelfLabel, { count: 4, icon: () => null, label: "Done", unread: 0 }),
    )
    expect(html).toMatch(/data-slot="badge"[^>]*>4<\/span>/)
    expect(html).toMatch(/<span class="sr-only">, (<!-- -->)?0(<!-- -->)? unread<\/span>/)
  })

  test("each row ends in its ShelfMark, the open row and every shelf", () => {
    expect(source).toContain("<ShelfMark empty={shown.length === 0} />")
    expect(source).toContain("<ShelfMark empty={shelf.length === 0} />")
  })

  test("the open row reads Inbox and its own count as the shelves do, zero included, the summary kept for a screen reader", () => {
    expect(source).toMatch(
      />\n\s+Inbox\n\s+<\/span>\n\s+<span className="sr-only">\{summary \?\? "All caught up"\}<\/span>/,
    )
    expect(source).toMatch(
      /<\/span>\n\s+\{\/\*[^\n]*\*\/\}\n\s+<Badge variant="outline" className="text-2xs h-4 px-1\.5 font-mono tabular-nums">\n\s+\{shown\.length\}/,
    )
  })

  test("a fold keeps the open cards mounted, so what a card holds (a draft typed) is still there when the list opens again", () => {
    expect(source).toContain("<AccordionContent keepMounted className={SHELF_PANEL}>")
  })

  test("a shut shelf keeps its cards mounted too, so a card opened there is still opened when its row opens again (PG-644)", () => {
    const shelves = source.slice(source.indexOf("<ShelfMark empty={shelf.length === 0} />"))
    expect(shelves).toMatch(
      /<AccordionContent keepMounted className=\{SHELF_PANEL\}>\n\s+<div role="list"/,
    )
  })

  test("the open row's tick is a single ✓ while anything is unread, and a muted ✓✓ All read once all is, the shelves' ✓ too", () => {
    const actions = source.slice(source.indexOf("const actions ="), source.indexOf("const bulk ="))
    expect(actions).toContain("const actions = (pill || rows.length > 0) && (")
    expect(actions).toMatch(
      /\{config\.hosted \? null : clearing === 0 \? \(\n\s+<span[^>]*>\n\s+<RiCheckDoubleLine className="size-3" aria-label="All read" \/>/,
    )
    expect(actions).toContain("<RiCheckLine />")
    const shelf = source.slice(
      source.indexOf("export function ShelfDismiss"),
      source.indexOf("export function ShelfDismiss") + 900,
    )
    expect(shelf).toContain("<RiCheckLine />")
  })

  test("Mark all as read is a bare icon button laid over the open row, named and hinted, outside the trigger: it marks every unread item seen and answers and dismisses none", () => {
    const actions = source.slice(source.indexOf("const actions ="), source.indexOf("const bulk ="))
    expect(actions).toContain('aria-label="Mark all as read"')
    expect(actions).toContain('size="icon-xs"')
    expect(actions).toContain('variant="ghost"')
    expect(actions).toContain(
      "<Hint content={`Mark all as read: ${clearing} stay in the list until done`}>",
    )
    expect(actions).toContain("void bulk(() => markRead(unreadIds))")
    expect(actions).not.toContain("dismissItems")
    expect(actions).not.toContain("answerItem")
    expect(source).toContain(
      '.filter((item) => item.readAt === null && (item.kind === "update" || item.status === "open"))',
    )
    expect(source).toContain('pill ? "pr-40" : rows.length > 0 && "pr-10",')
    // the header holds it beside the trigger, never inside it, so pressing it never folds the row
    expect(source).toMatch(/\{props\.children\}\n\s+\{actions\}\n\s+<\/h3>/)
  })

  // 1 new update follows the Dismiss all pattern, in white
  test("the new-update pill is an xs Button at its own radius, white, the open row's one call to act", () => {
    type Element = { props: Record<string, unknown> }
    const pill = (
      [NewPill({ count: 2, leaving: false, onTake: () => {} })] as unknown as Element[]
    ).find((e) => "size" in e.props)
    expect(pill?.props.size).toBe("xs")
    expect(pill?.props.variant).toBeUndefined()
    expect(String(pill?.props.className)).not.toContain("rounded-full")
  })

  test("the note's least height follows its card's first choice as that grows, and is one line with no choices", () => {
    const note = source.slice(source.indexOf("function NoteBox"), source.indexOf("const GLIDE_MS"))
    expect(note).toContain('.querySelector<HTMLElement>("[data-slot=questionnaire-choices] > *")')
    expect(note).toContain("new ResizeObserver(")
    expect(note).toContain("area.style.minHeight = `${choice.offsetHeight}px`")
    expect(note).toContain("observer.observe(choice)")
    // with no choices (a draft), as tall as an Approve choice
    expect(note).toContain('className={cn("min-h-14 py-2", BOX)}')
  })

  test("inbox.tsx draws no Marker of its own and no second fold: the accordion is its one, the first load's disabled row aside", () => {
    const loading = source.slice(
      source.indexOf("function InboxLoading"),
      source.indexOf("export function Inbox("),
    )
    expect(loading.match(/<Accordion\b/g)?.length).toBe(1)
    expect(loading).toContain('<AccordionItem value="open" disabled')
    expect(source).not.toContain("<Marker")
    expect(source).not.toContain("<Collapsible")
    expect(source.replace(loading, "").match(/<Accordion\b/g)?.length).toBe(1)
  })
})

// The space below Done holds a preview tab for active development.
describe("the Preview row under Done", () => {
  const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
  const row = source.slice(source.indexOf('<AccordionItem value="Preview"'))

  test("reads Preview with no count, as a shelf row reads its name", () => {
    const html = renderToStaticMarkup(
      createElement(ShelfLabel, { icon: () => null, label: "Preview" }),
    )
    expect(html).toContain("Preview")
    expect(html).not.toContain('data-slot="badge"')
  })

  test("is the accordion's last row, after Done, and holds the preview pane", () => {
    expect(source.indexOf('["done", RiCheckDoubleLine, done]')).toBeGreaterThan(-1)
    expect(source.indexOf('["done", RiCheckDoubleLine, done]')).toBeLessThan(
      source.indexOf('<AccordionItem value="Preview"'),
    )
    expect(row.slice(0, row.indexOf("</AccordionItem>"))).toContain("<PreviewPane />")
    expect(row.indexOf("</AccordionItem>")).toBeLessThan(row.indexOf("</Accordion>"))
  })

  test("is always there, even with an empty Inbox, and starts shut but opens whatever the shelves hold", () => {
    expect(row.slice(0, row.indexOf(">"))).not.toContain("disabled")
    expect(source).not.toContain("if (items.length === 0)")
    expect(source).toContain(
      '...shelvesOpen.filter((key) => key === "Preview" || (shelfSizes[key] ?? 0) > 0)',
    )
    expect(source).toContain("const [shelvesOpen, setShelvesOpen] = useState<string[]>([])")
  })
})

// The inbox's text takes shadcn's AI Elements (https://ui.shadcn.com/docs/components/base/questionnaire): every card is one question on shadcn's Questionnaire, composed with the Card's slots as shadcn's own card example does.
describe("every kind of card on the Questionnaire", () => {
  const draft = {
    ...decision,
    kind: "draft",
    preview: {
      link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
      text: "hi",
      to: "Merritt DM",
    },
  } as InboxItem
  const update = {
    ...decision,
    kind: "update",
    preview: { outcome: "merged" },
    status: "done",
    title: "Merged: changelog entries read as text",
  } as InboxItem
  const failed = {
    ...decision,
    answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve" },
    delivery: { code: "NOT_FOUND", reason: "No live session is named ops.", status: "failed" },
    status: "approved",
  } as InboxItem
  const doneCard = (item: InboxItem) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          DashboardContext,
          { value: { workers: [] } as unknown as DashboardContext },
          createElement(InboxCard, {
            shelf: "done",
            item,
            marked: false,
            now: Date.parse("2026-10-12T10:25:00.000Z"),
            paused: false,
            updated: false,
          }),
        ),
      ),
    )

  // the card's one question: the form, its shown item, and the title that names it
  const question = (html: string, title: string) => {
    expect(html).toContain('data-slot="questionnaire"')
    const item = /<fieldset [^>]*data-slot="questionnaire-item"[^>]*>/.exec(html)?.[0] ?? ""
    expect(item).toContain("data-active")
    expect(item).not.toContain("hidden")
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(item)?.[1]
    const heading = new RegExp(`<div data-slot="questionnaire-title"[^>]*id="${labelledBy}"[^>]*>`)
    expect(html).toMatch(heading)
    expect(html.split(heading)[1]).toContain(title)
  }
  const description = (html: string) =>
    html.split('data-slot="questionnaire-description"')[1]?.split("</div>")[0] ?? ""
  // the last description's own opening tag, an answered card's result's
  const resultTag = (html: string) =>
    [...html.matchAll(/<[a-z]+ [^>]*data-slot="questionnaire-description"[^>]*>/g)].at(-1)?.[0] ??
    ""

  test("a decision's title is the question and what Approve does is its description", () => {
    const html = render(false)
    question(html, "Ship canary 3f9a2c1 to main?")
    expect(description(html)).toContain("On Approve, main moves to")
  })

  test("a Slack decision's words stay plain text, line breaks kept and nothing rendered, so what is sent is what was read", () => {
    const slack = {
      ...decision,
      preview: {
        link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
        text: "hey **merritt**\nsee [the fix](https://example.com)",
        to: "@Merritt",
        type: "slack",
      },
    } as InboxItem
    const html = render(false, slack)
    expect(description(html)).toContain("hey **merritt**\nsee [the fix](https://example.com)")
    expect(description(html)).toContain("whitespace-pre-wrap")
    expect(description(html)).not.toContain("<strong")
  })

  test("a Slack decision's thread so far leads it, each gist rendered as transcript text under who said it, the reply still plain", () => {
    const slack = {
      ...decision,
      preview: {
        link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
        text: "on it, **merritt**",
        thread: [{ said: "the export ends at **100** rows", who: "Merritt" }],
        to: "@Merritt",
        type: "slack",
      },
    } as InboxItem
    // the gist's markdown holds divs of its own, so the description is read past its first </div>
    const html = render(false, slack).split('data-slot="questionnaire-description"')[1] ?? ""
    const [soFar = "", reply = ""] = html.split("On Approve")
    expect(soFar).toContain("So far")
    expect(soFar).toContain("Merritt:</span>")
    expect(soFar).toContain(`data-streamdown="strong"`)
    expect(reply).toContain("on it, **merritt**")
    expect(reply).not.toContain("data-streamdown")
  })

  test("a Slack decision shows its files under the message, as an ask's show (PG-648)", () => {
    const shot = { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png", kind: "image", name: "a.png" }
    const preview = {
      link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
      text: "the fix is on staging",
      to: "@Merritt",
      type: "slack",
    }
    const thumbs = (html: string) => html.split('data-slot="attachment-thumbs"').length - 1
    const shown = render(false, {
      ...decision,
      preview: { ...preview, attachments: [shot] },
    } as InboxItem)
    const ask = render(false, {
      ...decision,
      preview: { attachments: [shot], text: "hi", type: "ask" },
    } as InboxItem)
    expect(thumbs(shown)).toBe(1)
    expect(thumbs(shown)).toBe(thumbs(ask))
    expect(shown.indexOf('data-slot="attachment-thumbs"')).toBeGreaterThan(
      shown.indexOf("the fix is on staging"),
    )
    expect(thumbs(render(false, { ...decision, preview } as InboxItem))).toBe(0)
  })

  test("a labelled ask is shadcn's questionnaire card: numbered choices, and Send as Submit in the footer's actions inside the form", () => {
    const labelled = {
      ...decision,
      preview: { approve: "It ships.", deny: "It waits.", text: "Ship it.", type: "ask" },
    } as InboxItem
    const html = render(false, labelled)
    question(html, "Ship canary 3f9a2c1 to main?")
    expect(html.split("<form").length - 1).toBe(1)
    expect(/<form [^>]*>/.exec(html)?.[0]).toContain('data-shortcuts="numbers"')
    const [inside, outside] = html.split("</form>")
    expect(inside!.split("</fieldset>")[0]).toContain('data-slot="questionnaire-choice"')
    const actions =
      inside!.split('data-slot="card-footer"')[1]?.split('data-slot="questionnaire-actions"')[1] ??
      ""
    expect(named(actions, "Send")).toContain('data-slot="questionnaire-submit"')
    expect(named(actions, "Send")).toContain('type="submit"')
    for (const label of ["Archive", "Later", "Dismiss"]) {
      if (named(actions, label)) expect(named(actions, label)).toContain('type="button"')
    }
    // no Edit: the note carries any change
    expect(named(actions, "Edit")).toBe("")
    expect(named(actions, "Archive")).not.toBe("")
    expect(outside).not.toContain('data-slot="card-footer"')
  })

  test("a labelled ask with no side picked offers Send off, saying why, at the footer's left end, and never the Questionnaire's error", () => {
    const labelled = {
      ...decision,
      preview: { approve: "It ships.", deny: "It waits.", text: "Ship it.", type: "ask" },
    } as InboxItem
    const html = render(false, labelled)
    const send = named(html, "Send")
    expect(send).toContain('aria-disabled="true"')
    expect(send).not.toMatch(/\sdisabled=""/)
    expect(send).toContain('aria-description="Pick an option first"')
    expect(tipsOf(html.split(send)[1] ?? "")[0]).toBe("Pick an option first")
    expect(html).not.toContain('data-slot="questionnaire-error"')
    for (const [choice] of html.matchAll(/<input [^>]*type="radio"[^>]*>/g)) {
      expect(choice).not.toMatch(/\srequired=""/)
    }
    const actions = html.split('data-slot="questionnaire-actions"')[1] ?? ""
    const buttons = [...actions.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map(([b]) => b)
    expect(buttons[0]).toContain('data-slot="questionnaire-submit"')
    expect(buttons[1]).toContain('aria-label="Later"')
    expect(buttons[2]).toContain('aria-label="Archive"')
    expect(/data-slot="questionnaire-actions" class="([^"]*)"/.exec(html)?.[1]).toMatch(
      /\bflex flex-wrap\b/,
    )
  })

  test("a labelled ask that just moved holds its choices, so the number keys pick nothing, and its Send, still focusable and saying why", () => {
    const labelled = {
      ...decision,
      preview: { approve: "It ships.", deny: "It waits.", text: "Ship it.", type: "ask" },
    } as InboxItem
    const html = render(true, labelled)
    // the choices stay enabled so a checked card never reads unanswered: their group takes no pointer and reads busy, and their change is ignored, so a number key picks nothing
    const choices = [...html.matchAll(/<input [^>]*type="radio"[^>]*>/g)].map(([tag]) => tag)
    expect(choices).toHaveLength(2)
    for (const choice of choices) expect(choice).not.toMatch(/\sdisabled=""/)
    expect(html).toMatch(
      /<[^>]*data-slot="questionnaire-choices"[^>]*aria-busy="true"[^>]*>|<[^>]*aria-busy="true"[^>]*data-slot="questionnaire-choices"[^>]*>/,
    )
    const send = named(html, "Send")
    expect(send).toContain('aria-disabled="true"')
    expect(send).not.toMatch(/\sdisabled=""/)
    expect(tipsOf(html.split(send)[1] ?? "")[0]).toBe(
      "This item just moved: its buttons wake in a moment",
    )
  })

  test("a card but an open decision keeps its footer outside the form, so a key pressed on its buttons or its time field never submits the question", () => {
    for (const html of [render(false, draft), render(false, failed)]) {
      const [inside, outside] = html.split("</form>")
      expect(inside).not.toContain('data-slot="card-footer"')
      expect(outside).toContain('data-slot="card-footer"')
    }
  })

  test("a draft is a question whose words he edits in place", () => {
    const html = render(false, draft)
    question(html, "Ship canary 3f9a2c1 to main?")
    expect(html.split("</fieldset>")[0]).toContain('aria-label="Message to Merritt DM"')
  })

  test("a draft with a thread so far shows it above Your message, and one without shows neither, never Your reply", () => {
    const threaded = render(false, {
      ...draft,
      preview: {
        link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
        text: "hi",
        thread: [{ said: "can you try the export again?", who: "Merritt" }],
        to: "Merritt DM",
      },
    } as InboxItem)
    expect(threaded.indexOf("So far")).toBeGreaterThan(-1)
    expect(threaded.indexOf("So far")).toBeLessThan(threaded.indexOf("Your message"))
    expect(threaded).not.toContain("Your reply")
    expect(threaded.indexOf("Your message")).toBeLessThan(
      threaded.indexOf('aria-label="Message to Merritt DM"'),
    )
    const plain = render(false, draft)
    expect(plain).not.toContain("So far")
    expect(plain).not.toContain("Your message")
  })

  test("an update is a question with its title alone", () => {
    const html = render(false, update)
    question(html, "Merged: changelog entries read as text")
    expect(html).not.toContain('data-slot="questionnaire-description"')
  })

  test("a failed send's result is its last description, under what Approve does, in red, with Retry", () => {
    const html = render(false, failed)
    question(html, "Ship canary 3f9a2c1 to main?")
    expect(description(html)).toContain("On Approve, main moves to")
    const last = html.split('data-slot="questionnaire-description"').at(-1)!.split("</div>")[0]
    expect(last).toContain("Send failed: No live session is named ops.")
    expect(resultTag(html)).toContain("text-destructive")
    expect(named(html, "Retry")).not.toBe("")
  })

  test("a card in Done is the same question, with no gray behind it", () => {
    const html = doneCard(update)
    question(html, "Merged: changelog entries read as text")
    expect(html).not.toContain("bg-muted/40")
  })

  test("no card wears a coloured left edge, in any state, since a thick coloured border reads as noise", () => {
    const alert = {
      ...update,
      preview: { outcome: "alert" },
      title: "Disk is nearly full",
    } as InboxItem
    for (const html of [
      render(false),
      render(false, draft),
      render(false, update),
      render(false, alert),
      render(false, failed),
      doneCard(update),
    ]) {
      expect(html).not.toMatch(/before:(bg-|w-|absolute)/)
      // only the quoted words' neutral rule, never a coloured edge on the card
      for (const edge of html.match(/border-l-\S+/g) ?? []) expect(edge).toBe("border-l-2")
      expect(html).not.toMatch(/border-l-2[^"]*border-(caution|destructive|info|success|warning)/)
    }
  })
})

describe("an ask's text renders as chat does", () => {
  const ask = (text: string) =>
    ({ ...decision, id: "id-92", preview: { text, type: "ask" } }) as InboxItem

  test("a fenced block shows as a highlighted code block with its copy button", () => {
    const html = render(false, ask("Run this:\n\n```ts\nconst a = 1\n```"))
    expect(html.match(/data-slot="code-block"/g)).toHaveLength(1)
    expect(html).toContain('data-slot="code-block-copy-button"')
    expect(html).toContain("Run this:")
  })

  test('code reads at the small size and wraps, as the owner asked ("the font is too large in codeblock")', () => {
    const html = render(false, ask("```ts\nconst a = 1\n```"))
    expect(html).toContain('data-slot="code-block" data-variant="default" data-size="sm"')
    expect(html).toContain('data-wrap="true"')
  })

  test('a drawing never wraps, its font fitting its widest line to the card ("should be width aware ascii\'s and all")', () => {
    const html = render(false, ask("```text\n+----+\n| ok |\n+----+\n```"))
    expect(html).not.toContain('data-wrap="true"')
    expect(html).toMatch(/data-slot="code-block"[^>]*@container/)
  })

  test('a drawing\'s rows sit close so box-drawing lines join, while code keeps its spacing ("looks right but not connected, ascii art would be hard this way")', () => {
    expect(render(false, ask("```\n┌─┐\n└─┘\n```"))).toMatch(/<pre [^>]*leading-\[1\.3\]/)
    expect(render(false, ask("```ts\nconst a = 1\n```"))).not.toContain("leading-[1.3]")
  })

  test("a code block takes the table's border, not the input's brighter one (\"the codeblock border color is brighter than table and image/file border\")", () => {
    const block = /<div [^>]*data-slot="code-block"[^>]*>/.exec(
      render(false, ask("```ts\nconst a = 1\n```")),
    )?.[0]
    expect(block).toContain("border-border")
    expect(block).not.toContain("border-input")
  })

  test("plain text keeps its words and every line break, with no code block", () => {
    const html = render(false, ask("First line\nSecond line"))
    expect(html).not.toContain('data-slot="code-block"')
    expect(html).toMatch(/First line<br\/>\s*Second line/)
  })
})

// a card that only shows something asks nothing, so it carries no Approve or Deny
describe("a read-only card: an update that shows an ask's text and files", () => {
  const update = {
    ...decision,
    id: "id-93",
    kind: "update",
    preview: { outcome: "finding" },
    status: "done",
  } as InboxItem
  const shown = {
    ...update,
    preview: {
      attachments: [
        { id: "0b7c4e2a-1f3d-4c5e-8a9b-2d6f7e8a9b0c.png", kind: "image", name: "table.png" },
      ],
      outcome: "finding",
      text: "The table you asked for:\n\n```ts\nconst rows = 3\n```",
    },
  } as InboxItem

  test("renders its words as an ask's, with its file, and no Approve, Deny or On Approve line", () => {
    const html = render(false, shown)
    expect(html).toContain("The table you asked for:")
    expect(html.match(/data-slot="code-block"/g)).toHaveLength(1)
    expect(html).toContain('data-slot="attachment-thumbs"')
    expect(html).toContain("table.png")
    expect(html).not.toContain("On Approve")
    expect(html).not.toContain(">Approve<")
    expect(html).not.toContain(">Deny<")
    expect(html).not.toContain('data-slot="questionnaire-choice"')
    expect(named(html, "Mark as read")).not.toBe("")
    expect(named(html, "Dismiss")).not.toBe("")
  })

  test("an update with no words or files renders as it does today", () => {
    const html = render(false, update)
    expect(html).not.toContain('data-slot="questionnaire-description"')
    expect(html).not.toContain('data-slot="attachment-thumbs"')
  })

  test("a labelled ask still shows its Approve and Deny", () => {
    const html = render(false, {
      ...decision,
      preview: { approve: "Ships.", deny: "Waits.", text: "Ship it?", type: "ask" },
    } as InboxItem)
    expect(html).toContain(">Approve</span>")
    expect(html).toContain(">Deny</span>")
  })
})

// Images and code blocks keep the same gap as the rest.
describe("an ask's files in its card", () => {
  test("sit gap-3 below the words, as the choices sit below them (their gap-3 apart is the thumbnails' own)", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/inbox.tsx")).text()
    expect(source).toContain(
      'className="flex flex-col gap-1 text-xs [&>[data-slot=attachment-thumbs]]:mt-2"',
    )
  })
})

describe("a ship decision's PRs", () => {
  test("each opens its page from the card when the item names it, and an older item's reads as before", () => {
    const html = render(false, {
      ...decision,
      preview: {
        prs: [{ number: 270, title: "x", url: "https://github.com/acme/app/pull/270" }],
        sha: "3f9a2c1",
        type: "ship",
      },
    } as InboxItem)
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/github.com\/acme\/app\/pull\/270"[^>]*target="_blank"[^>]*>#270<\/a> x/,
    )
    expect(render(false)).toContain("#270 x")
  })
})

describe("a delete decision's why", () => {
  test("renders as markdown, so each target's PR opens from the card, while what stays the plain text Approve deletes", () => {
    const html = render(false, {
      ...decision,
      preview: {
        type: "delete",
        what: "- worktree `/m/.claude/worktrees/pg-2`",
        why: "Left over.\n\n- worktree `pg-2`: [#12](https://github.com/acme/app/pull/12)",
      },
      title: "Delete 1 leftover the nightly cleanup found",
    } as InboxItem)
    expect(html).toMatch(/<a [^>]*href="https:\/\/github.com\/acme\/app\/pull\/12"[^>]*>#12<\/a>/)
    expect(html).toContain("- worktree `/m/.claude/worktrees/pg-2`")
  })
})

describe("a guard decision's card (PG-1090)", () => {
  const value = { path: "/made/up/send", selfDm: "D0MADEUP1", servers: ["made-up-slack"] }
  const guard = (preview: object) =>
    render(false, {
      ...decision,
      preview: {
        key: "slack.gatedSends",
        scope: "acme-test",
        type: "guard",
        why: "A made-up gate",
        ...preview,
      },
      title: "Gate acme-test's Slack sends?",
    } as InboxItem)
  // the markup as React writes text: quotes and ampersands as their entities
  const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

  test("shows the key, the scope and the value as the JSON Approve writes", () => {
    const html = guard({ value })
    expect(html).toContain("sets the guard setting")
    expect(html).toContain(">slack.gatedSends</code>")
    expect(html).toContain(">acme-test</code>")
    expect(html).toContain(escaped(JSON.stringify(value, null, 2)))
  })

  test("with no value, reads that Approve takes the setting back to its default, and draws no value", () => {
    const html = guard({})
    expect(html).toContain("takes the guard setting")
    expect(html).toContain(" back to its default.")
    expect(html).not.toContain("<pre")
  })
})

describe("an own decision's card (PG-1162)", () => {
  const own = (preview: object) =>
    render(false, {
      ...decision,
      preview: {
        key: "pat@example.com",
        own: true,
        scope: "made-up-me",
        type: "own",
        why: "A made-up reason",
        ...preview,
      },
      title: "Mark pat@example.com as your own?",
    } as InboxItem)

  test("shows the email, the scope and the change Approve makes", () => {
    const html = own({})
    expect(html).toContain("the dashboard marks")
    expect(html).toContain(">pat@example.com</code>")
    expect(html).toContain(">made-up-me</code>")
    expect(html).toContain("off → on")
    expect(html).toContain("Why: A made-up reason")
  })

  test("a clear reads unmarks, on to off", () => {
    const html = own({ own: false })
    expect(html).toContain("the dashboard unmarks")
    expect(html).toContain("on → off")
  })
})

describe("a held Yard post's card", () => {
  test("its Approve is a link that opens Yard's approve page in a new tab, never an answer", () => {
    const html = render(false, {
      ...decision,
      kind: "update",
      preview: {
        approve: "https://yard.example/yard/approve/m1",
        outcome: "decision",
        text: "run it",
      },
      status: "done",
    } as InboxItem)
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/yard.example\/yard\/approve\/m1"[^>]*target="_blank"[^>]*>.*?Approve<\/a>/,
    )
  })
})

// PG-1074: each shelf's row does what its place says, so renaming a row's words changes those words alone.
describe("the shelves under the list, by place", () => {
  const at = "2026-10-12T10:05:00.000Z"
  const card = (ref: number, over: object) =>
    ({ ...decision, id: `id-${ref}`, ref, title: `Fake card ${ref}`, ...over }) as InboxItem
  const working = card(60, {
    answer: { at, choice: "approve" },
    delivery: { at, status: "delivered", via: "session" },
    status: "approved",
  })
  // an update read before Done kept updates in the list is on Done, unread until dismissed
  const update = {
    kind: "update",
    preview: { outcome: "merged" },
    readAt: "2026-10-12T10:00:00.000Z",
    status: "done",
  }
  const settled = card(61, update)
  const read = card(62, { ...update, answer: { dismissedAt: at } })
  const inbox = (done: InboxItem[]) => {
    const client = new QueryClient() as { setQueryData: (key: unknown, data: unknown) => void }
    client.setQueryData(INBOX_QUERY_KEY, {
      archived: [card(63, { answer: { at, choice: "clear" }, status: "cleared" })],
      items: [working, ...done],
      snoozed: [card(64, { answer: { at, snoozedUntil: "2026-10-13T10:00:00.000Z" } })],
    })
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          DashboardContext,
          { value: { allowed: true, workers: [] } as unknown as DashboardContext },
          createElement(Inbox, { viewing: true }),
        ),
      ),
    )
  }
  // each shelf's header, by the words its row shows
  const header = (html: string, label: string) =>
    html
      .split("<h3")
      .find((row) => row.split("</h3>")[0]!.includes(`>${label}<`))
      ?.split("</h3>")[0] ?? ""
  // the count badge a shelf's header shows
  const count = (row: string) => /data-slot="badge"[^>]*>(\d+)<\/span>/.exec(row)?.[1]
  const renamed = { archived: "Bench", done: "Tally", progress: "Forge", snoozed: "Drift" }
  const withLabels = (labels: typeof SHELF_LABELS, render: () => string) => {
    const kept = { ...SHELF_LABELS }
    Object.assign(SHELF_LABELS, labels)
    try {
      return render()
    } finally {
      Object.assign(SHELF_LABELS, kept)
    }
  }

  test("each shelf counts what it holds; Archive's ✓ dismisses each card, Done's marks what is unread as read, and In progress and Later have none", () => {
    const html = inbox([settled])
    expect(header(html, "Archive")).toContain('aria-label="Dismiss all in Archive"')
    expect(header(html, "Done")).toContain('aria-label="Mark all in Done as read"')
    expect(header(html, "Done")).toMatch(
      /<span class="sr-only">, (<!-- -->)?1(<!-- -->)? unread<\/span>/,
    )
    expect(header(html, "Done")).not.toContain("opacity-50 hover:opacity-100")
    for (const label of ["In progress", "Later", "Archive", "Done"])
      expect(count(header(html, label))).toBe("1")
    for (const label of ["In progress", "Later"]) {
      expect(header(html, label)).not.toBe("")
      expect(header(html, label)).not.toContain("aria-label=")
    }
  })

  test("Done with nothing left to read reads muted as an empty shelf, its ✓ gone, its count its history", () => {
    const row = header(inbox([read]), "Done")
    expect(row).toContain("opacity-50 hover:opacity-100 aria-expanded:opacity-100")
    // its count is its history too, the read card included
    expect(count(row)).toBe("1")
    expect(row).toMatch(/<span class="sr-only">, (<!-- -->)?0(<!-- -->)? unread<\/span>/)
    expect(row).not.toContain("Mark all in Done as read")
  })

  test("renaming every row's words leaves what each row does unchanged", () => {
    for (const done of [[settled], [read]]) {
      const kept = inbox(done)
      const html = withLabels(renamed, () => inbox(done))
      expect(header(html, "Bench")).toContain('aria-label="Dismiss all in Bench"')
      if (done[0] === settled)
        expect(header(html, "Tally")).toContain('aria-label="Mark all in Tally as read"')
      const back = Object.entries(renamed).reduce(
        (text, [place, label]) =>
          text.replaceAll(label, SHELF_LABELS[place as keyof typeof renamed]),
        html,
      )
      expect(back).toBe(kept)
    }
  })
})

// The aside's first load drew a Spinner in the pane's middle, then swapped it for the whole Inbox at once (PG-875).
describe("the Inbox before its first read lands", () => {
  // a dashboard the owner may not read keeps the read pending, as a first load is
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        DashboardContext,
        { value: { allowed: false, workers: [] } as unknown as DashboardContext },
        createElement(Inbox, { viewing: true }),
      ),
    ),
  )
  test("draws its open row where it will sit with the Mark all as read room kept, and no count bubble until the read lands (PG-1686)", () => {
    expect(html).toMatch(/<section aria-busy="true" aria-label="Inbox"/)
    const row = html.split("<h3")[1]!.split("</h3>")[0]!
    expect(row).toContain(">Inbox</span>")
    expect(row).toContain("pr-10")
    expect(html).not.toContain('data-slot="badge"')
  })
  test("once the read lands, the open row and every shelf show their count, 0 included (PG-1686)", () => {
    const client = new QueryClient() as { setQueryData: (key: unknown, data: unknown) => void }
    client.setQueryData(INBOX_QUERY_KEY, { archived: [], items: [], snoozed: [] })
    const loaded = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          DashboardContext,
          { value: { allowed: true, workers: [] } as unknown as DashboardContext },
          createElement(Inbox, { viewing: true }),
        ),
      ),
    )
    expect(loaded).not.toContain("aria-busy")
    const counts = loaded
      .split("<h3")
      .slice(1)
      .map((row) => /data-slot="badge"[^>]*>(\d+)<\/span>/.exec(row.split("</h3>")[0]!)?.[1])
    // the open row and In progress, Later, Archive and Done each read 0; Preview carries no count
    expect(counts).toEqual(["0", "0", "0", "0", "0", undefined])
  })
  test("shows the Spinner under the row and no shelf until the read lands", () => {
    expect(html.indexOf('data-slot="spinner"')).toBeGreaterThan(html.indexOf("</h3>"))
    expect(html.match(/<h3/g)).toHaveLength(1)
    expect(html).not.toContain("absolute inset-0")
  })
})

// PG-900: one word a meaning, as the Inbox plan's verb table names them; each label below was another word on canary.
describe("one word a meaning: Later, Archive, Reply and Replying (PG-900)", () => {
  const answered = {
    ...decision,
    answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve" },
    status: "approved",
  } as InboxItem

  test("an open ask's put-away button is Later, its tip saying what it does, and no button reads Snooze", () => {
    const html = render(false)
    expect(named(html, "Later")).not.toBe("")
    expect(html).not.toContain("Snooze")
    expect(tipsOf(html)).toContain("Later: put it away until a time, then it asks again")
  })

  test("the card's button is Reply, and the card the chat's words name as re #iN reads Replying in its band, with no fill", () => {
    const html = opened(answered)
    expect(html).toContain('aria-label="Reply to #i41"')
    expect(html).not.toContain("Chat about")
    expect(html).not.toContain(">Replying<")
    const marked = render(false, answered, false, { defaultOpen: true, marked: true })
    expect(marked).toContain(">Replying<")
    // an outline chip at the band's 16px line, so the band keeps its height and the chip draws its pill on the muted band
    const chip = marked.slice(0, marked.indexOf(">Replying<")).split("<").at(-1)!
    for (const kept of ['data-slot="badge"', "h-4", "text-2xs", "border-border"])
      expect(chip).toContain(kept)
    for (const gone of ["h-5", "bg-secondary"]) expect(chip).not.toContain(gone)
    expect(marked.split(">")[0]).toContain('data-slot="card"')
    expect(marked.split(">")[0]).not.toContain("bg-muted/50")
  })

  test("the shelves read Later and Archive", () => {
    const source = readFileSync(join(web, "src/components/dashboard/inbox.tsx"), "utf8")
    for (const old of ['"Snoozed"', '"Archived"', "Mark all done as read", "Dismiss all archived"])
      expect(source).not.toContain(old)
    expect(SHELF_LABELS).toMatchObject({ archived: "Archive", snoozed: "Later" })
  })
})

// A draft card's changed words outlive a remount (a list refresh, a shelf move), kept in the composer's draft store under the card's own key, and its sent words never take a kept edit.
describe("a draft card's changed words", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const store = new Map<string, string>()
  beforeAll(() =>
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => void store.delete(key),
        setItem: (key: string, value: string) => void store.set(key, value),
      } as Storage,
    }),
  )
  afterEach(() => {
    for (const to of Object.keys(readDrafts())) saveDraft(to, { attachments: [], text: "" })
  })
  afterAll(() => {
    if (real) Object.defineProperty(globalThis, "localStorage", real)
    else delete (globalThis as { localStorage?: Storage }).localStorage
  })

  const draft = {
    ...decision,
    kind: "draft",
    preview: {
      link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
      text: "hi",
      to: "Merritt DM",
    },
  } as InboxItem
  const box = (html: string) =>
    html.match(/<textarea[^>]*aria-label="Message to Merritt DM"[^>]*>([^<]*)<\/textarea>/)?.[1]
  const keep = (text: string) => saveDraft(cardDraftKey(draft.id), { attachments: [], text })

  test("come back in its box when the card mounts again", () => {
    keep("hi, the ship moves to Friday")
    expect(box(opened(draft))).toBe("hi, the ship moves to Friday")
  })

  test("come back in a card a reply collapsed, once it is opened again", () => {
    keep("hi, the ship moves to Friday")
    const replied = {
      ...draft,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "replied" },
    } as InboxItem
    expect(box(opened(replied))).toBe("hi, the ship moves to Friday")
  })

  test("never show on a sent card, which reads the words as they went", () => {
    keep("hi, the ship moves to Friday")
    const sent = {
      ...draft,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "send", editedText: "hi there" },
      status: "sent",
    } as InboxItem
    const html = opened(sent, "done")
    expect(box(html)).toBeUndefined()
    expect(html).toContain("hi there")
    expect(html).not.toContain("moves to Friday")
  })

  test("are another card's alone: a card shows its own words when only another's are kept", () => {
    saveDraft(cardDraftKey("id-42"), { attachments: [], text: "for another card" })
    expect(box(opened(draft))).toBe("hi")
  })
})

// A remount is a fresh static render that reads the picks store (no effects run), as a draft card's words come back under cardDraftKey. The store is seeded, then the card rendered, so each case proves what a list refresh or a shelf move gives back.
describe("an ask card's answer in progress (PG-1345)", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const store = new Map<string, string>()
  beforeAll(() =>
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => void store.delete(key),
        setItem: (key: string, value: string) => void store.set(key, value),
      } as Storage,
    }),
  )
  afterEach(() => {
    for (const id of Object.keys(readPicks())) savePicks(id, EMPTY_PICKS)
  })
  afterAll(() => {
    if (real) Object.defineProperty(globalThis, "localStorage", real)
    else delete (globalThis as { localStorage?: Storage }).localStorage
  })

  const single = (labels: string[]) =>
    ({
      ...decision,
      id: "id-70",
      preview: { options: labels.map((label) => ({ label })), text: "Pick a base.", type: "ask" },
      ref: 70,
      title: "Which base?",
    }) as InboxItem
  const multiItem = {
    ...decision,
    id: "id-71",
    preview: {
      questions: [
        { options: [{ label: "staging" }, { label: "main" }], question: "Which base?" },
        { options: [{ label: "now" }, { label: "later" }], question: "When?" },
      ],
      text: "Pick for each.",
      type: "ask",
    },
    ref: 71,
    title: "Port it, and when?",
  } as InboxItem
  const singleSig = (labels: string[]) =>
    choicesKey(choicesOf({ options: labels.map((label) => ({ label })), type: "ask" }))
  const multiSig = picksKey(
    questionsOf({
      questions: [
        { options: [{ label: "staging" }, { label: "main" }], question: "Which base?" },
        { options: [{ label: "now" }, { label: "later" }], question: "When?" },
      ],
      type: "ask",
    }),
  )
  // the value of every choice input the remount rendered checked, each `${letter}: ${label}` as AskChoices and QuestionChoices stamp it; the primitive carries value and data-checked on the input, not the choice root
  const picked = (html: string) =>
    [...html.matchAll(/<[^>]*data-slot="questionnaire-choice-input"[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /data-checked(?:=""|[\s>])/.test(tag))
      .map((tag) => tag.match(/value="([^"]*)"/)?.[1] ?? "")
  const note = (html: string) =>
    html.match(/<textarea[^>]*aria-label="Comment"[^>]*>([^<]*)<\/textarea>/)?.[1]

  test("a single ask gives back its pick and Note on remount", () => {
    savePicks("id-70", {
      ...EMPTY_PICKS,
      note: "Soak it.",
      pick: 1,
      sig: singleSig(["staging", "main"]),
    })
    const html = opened(single(["staging", "main"]))
    expect(picked(html)).toEqual(["B: main"])
    expect(note(html)).toBe("Soak it.")
  })

  test("a fresh single ask keeps none", () => {
    const html = opened(single(["staging", "main"]))
    expect(picked(html)).toEqual([])
    expect(note(html)).toBe("")
  })

  test("a multi ask gives back each pick and the question in sight", () => {
    savePicks("id-71", { ...EMPTY_PICKS, picks: [0, 1], sig: multiSig, step: 1 })
    const html = opened(multiItem)
    expect(picked(html)).toEqual(expect.arrayContaining(["A: staging", "B: later"]))
    // step 1 restored, not reset to 0: the second question is the active one, the first is held hidden
    const active = html.match(/<fieldset[^>]*data-active[^>]*>([\s\S]*?)<\/fieldset>/)?.[1] ?? ""
    expect(active).toContain("When?")
    expect(active).not.toContain("Which base?")
  })

  test("a single ask drops a pick whose options changed under the unmounted card, keeping the Note", () => {
    savePicks("id-70", {
      ...EMPTY_PICKS,
      note: "Soak it.",
      pick: 1,
      sig: singleSig(["staging", "main"]),
    })
    const html = opened(single(["revert", "delete", "wait"]))
    expect(picked(html)).toEqual([])
    expect(note(html)).toBe("Soak it.")
  })

  test("an answered card renders its result, not a kept answer's choices", () => {
    savePicks("id-70", {
      ...EMPTY_PICKS,
      note: "Soak it.",
      pick: 1,
      sig: singleSig(["staging", "main"]),
    })
    const answered = {
      ...single(["staging", "main"]),
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve", option: 0 },
      status: "approved",
    } as InboxItem
    expect(picked(opened(answered, "done"))).toEqual([])
  })

  test("another card's entry leaves this card untouched", () => {
    savePicks("id-99", { ...EMPTY_PICKS, note: "other", pick: 0, sig: singleSig(["a", "b"]) })
    const html = opened(single(["staging", "main"]))
    expect(picked(html)).toEqual([])
    expect(note(html)).toBe("")
  })
})

describe("a clone card (PG-2205)", () => {
  const FOLDER = "/made/up/data/extensions"
  const clone = {
    ...decision,
    id: "id-2205",
    preview: {
      repos: [
        {
          folder: `${FOLDER}/made-up-me`,
          repo: "made-up-me/playground-made-up-me",
          scope: "made-up-me",
        },
        {
          folder: `${FOLDER}/made-up-tools`,
          repo: "made-up-me/playground-made-up-tools",
          scope: "made-up-tools",
        },
      ],
      type: "clone",
      why: "This new machine has no extensions yet",
    },
    title: "Clone your extensions onto this machine?",
  } as unknown as InboxItem

  test("lists each repo it clones and the folder it fills, in order, with its why, and offers Clone", () => {
    const html = opened(clone)
    expect(html).toContain("On Approve, the dashboard clones")
    const first = html.indexOf("made-up-me/playground-made-up-me")
    const second = html.indexOf("made-up-me/playground-made-up-tools")
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(html).toContain(`${FOLDER}/made-up-me`)
    expect(html).toContain(`${FOLDER}/made-up-tools`)
    expect(html).toContain("Why: This new machine has no extensions yet")
    expect(html).toContain(">Clone the 2 repos<")
    expect(html).toContain(">Do not clone<")
  })

  test("once approved, reads the clone's result line, green or red by its exit code", () => {
    const line = "made-up-me/playground-made-up-me into /made/up/data/extensions/made-up-me"
    const done = {
      ...clone,
      answer: { at: "2026-10-12T10:05:00.000Z", choice: "approve", cloned: { exitCode: 0, line } },
      status: "approved",
    } as unknown as InboxItem
    expect(opened(done, "done")).toContain(`Cloned: ${line}`)
    const failed = {
      ...done,
      answer: {
        ...done.answer,
        cloned: {
          exitCode: 1,
          line: "made-up-me/playground-made-up-me is not on GitHub, so nothing was cloned",
        },
      },
    } as unknown as InboxItem
    expect(opened(failed, "done")).toContain(
      "Clone failed (exit 1): made-up-me/playground-made-up-me is not on GitHub, so nothing was cloned",
    )
  })
})

describe("a root step card (PG-2433)", () => {
  const scripts = [{ name: "bwrap-userns", sha256: "ab".repeat(32) }]
  const install = {
    ...decision,
    id: "id-2433",
    preview: { scripts, step: "install", type: "root", why: "No root step is installed yet" },
    title: "Install the root steps on this machine?",
  } as unknown as InboxItem
  const step = {
    ...install,
    preview: { step: "bwrap-userns", type: "root", why: "Claude Code's sandbox cannot start" },
    title: "Let Claude Code's sandbox start?",
  } as unknown as InboxItem
  const unescape = (html: string) =>
    html
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&")

  test("an install card shows the program text pkexec runs byte for byte, with each script's name and sha256", () => {
    const html = opened(install)
    const shown = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1]
    expect(unescape(shown ?? "")).toBe(INSTALL_TEXT)
    expect(html).toContain("bwrap-userns")
    expect(html).toContain("ab".repeat(32))
    expect(html).toContain("asks for your password in its own window")
    expect(html).toContain(">Install the root steps<")
    expect(html).toContain(">Do not install them<")
  })

  test("an install card shows the CA's fingerprint it pins, or says the browser step waits for one (PG-2458)", () => {
    const pinned = {
      ...install,
      preview: { ...install.preview, ca: { sha256: "cd".repeat(32) } },
    } as unknown as InboxItem
    const shown = unescape(opened(pinned))
    expect(shown).toContain(
      `only if its sha256 is <code class="font-mono break-all">${"cd".repeat(32)}</code>`,
    )
    expect(shown).toContain("A new certificate needs a new install card")
    expect(unescape(opened(install))).toContain(
      "The Dashboard has no certificate yet, so chromium-ca refuses until a later install card carries one",
    )
  })

  test("a step card names the one installed script it runs as root, and what it does", () => {
    const html = opened(step)
    expect(html).toContain(`${ROOT_DIR}/bwrap-userns`)
    expect(unescape(html)).toContain(ROOT_STEPS["bwrap-userns"].what)
    expect(unescape(html)).toContain(`To undo it: ${ROOT_STEPS["bwrap-userns"].undo}.`)
    expect(html).toContain(">Run bwrap-userns as root<")
  })

  test("a card for another machine names it, the sudo program byte for byte, the once-used password and the undo (PG-2434)", () => {
    const peer = {
      ...install,
      preview: { ...install.preview, machine: "spark-test" },
    } as unknown as InboxItem
    const html = opened(peer)
    const shown = unescape(html)
    expect(unescape(/<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "")).toBe(PEER_INSTALL_TEXT)
    expect(shown).toContain("runs this program there as root through sudo")
    expect(shown).toContain("The password is used once, then deleted from this computer")
    expect(shown).toContain(`through <code class="font-mono">${PEER_RULE}</code>`)
    expect(shown).toContain(
      `To undo it: remove <code class="font-mono">${PEER_RULE}</code> and <code class="font-mono">${PEER_POLICY}</code> on spark-test.`,
    )
    expect(shown).not.toContain("asks for your password in its own window")
    const peerStep = {
      ...step,
      preview: { ...step.preview, machine: "spark-test" },
    } as unknown as InboxItem
    const stepShown = unescape(opened(peerStep))
    expect(stepShown).toContain("on spark-test, then runs it there as root, with no password")
    expect(stepShown).toContain(`To undo it: ${ROOT_STEPS["bwrap-userns"].undo}, on spark-test.`)
  })

  test("once approved, reads the result, green or red by its exit code", () => {
    const done = {
      ...step,
      answer: {
        at: "2026-10-12T10:05:00.000Z",
        choice: "approve",
        rooted: { exitCode: 0, line: "bwrap may now make a user namespace" },
      },
      status: "approved",
    } as unknown as InboxItem
    expect(opened(done, "done")).toContain("Ran as root: bwrap may now make a user namespace")
    const closed = {
      ...done,
      answer: {
        ...done.answer,
        rooted: { exitCode: 126, line: "you closed the password window, so nothing ran as root" },
      },
    } as unknown as InboxItem
    expect(opened(closed, "done")).toContain(
      "Root step failed (exit 126): you closed the password window, so nothing ran as root",
    )
  })
})
