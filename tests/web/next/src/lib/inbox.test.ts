import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { InboxItem } from "../../../../../api/hono/src/lib/dashboard/inbox"
import {
  ACKS_STAMPED_FROM as API_ACKS_STAMPED_FROM,
  filesToUpload as API_filesToUpload,
  GO_CHOICES as API_GO_CHOICES,
  PLACED_TYPES as API_PLACED_TYPES,
  QUEUED_POLL_MS as API_QUEUED_POLL_MS,
  RETRY_CODES as API_RETRY_CODES,
  retryable as API_retryable,
  savesDraft as API_savesDraft,
  slackPlace as API_slackPlace,
  STUCK_QUEUED_MS as API_STUCK_QUEUED_MS,
} from "../../../../../api/hono/src/lib/dashboard/inbox"
import { CLOCKS_STOPPED_AT } from "../../../../../packages/config/src/inbox"
import { listedItem } from "../../../../../scripts/hooks/no-chat-question"
import {
  ACKS_STAMPED_FROM,
  canDraft,
  checkAnswerNote,
  commentRefused,
  decisionChoices,
  deliveryNote,
  cardKey,
  changedAt,
  dismissable,
  focusAfterTake,
  foldsByDefault,
  GO_CHOICES,
  inboxLight,
  inboxPosters,
  inboxSummary,
  inboxTarget,
  inboxView,
  inboxWaitOf,
  inboxWaiting,
  itemState,
  kindWord,
  MOVED_PAUSE_MS,
  movedRows,
  movedStep,
  needsYou,
  newLabel,
  outcomeLine,
  pickedAt,
  pinnedView,
  PLACED_TYPES,
  resultLink,
  RETRY_CODES,
  retryable,
  reopenable,
  reopenKey,
  schedulable,
  scheduleChoices,
  sendFailed,
  sendUnconfirmed,
  sendWhy,
  SHELF_LABELS,
  shelfRow,
  shelfToOpen,
  STUCK_QUEUED_MS,
  updatedSince,
  upfrontLink,
  slackPlaced,
  uploadsOn,
  verbs,
} from "../../../../../web/next/src/lib/inbox"
import { QUEUED_POLL_MS } from "../../../../../web/next/src/lib/outbox"
import { statusIcon } from "../../../../../web/next/src/lib/status-icons"
import { fullTime } from "../../../../../web/next/src/lib/time"
import { AFTER, ITEMS } from "../../../../scripts/hooks/inbox-items"

// Remix's icons resolve from the web app's own packages, which this directory cannot see.
const web = join(import.meta.dir, "../../../../../web/next")
const {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiSearchEyeLine,
} = (await import(Bun.resolveSync("@remixicon/react", web))) as Record<string, unknown>

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
          : { sha: "3f9a2c1", prs: [{ number: 270, title: "x" }], type: "ship" },
    readAt: null,
    ref: 1,
    status: over.kind === "update" ? "done" : "open",
    title: "Ship canary 3f9a2c1 to main?",
    updatedAt: "2026-10-07T10:00:00.000Z",
    version: 0,
    ...over,
  }) as InboxItem

const items = [
  item({ kind: "decision", ref: 41 }),
  item({ from: "dispatcher", kind: "draft", ref: 40 }),
  item({ kind: "update", ref: 44 }),
  item({ kind: "update", readAt: "2026-10-07T11:00:00.000Z", ref: 31 }),
  item({ answer: { at: "x", choice: "approve" }, kind: "decision", ref: 12, status: "approved" }),
]

describe("a secret ask (PG-59)", () => {
  const preview = {
    key: "GITHUB_CLIENT_SECRET",
    sink: { environments: ["production", "preview"], project: "p", scope: "s", type: "vercel" },
    type: "secret",
  }
  const asked = item({ kind: "decision", preview } as never)
  const provided = (results?: { environment: string; exitCode: number | null }[]) =>
    item({
      answer: { at: "2026-10-31T01:00:00.000Z", choice: "provided", results },
      kind: "decision",
      preview,
      status: "provided",
    } as never)

  test("needs you while open, then reads only when it was provided and each exit status", () => {
    expect(kindWord(asked)).toBe("Secret")
    expect(needsYou(asked)).toBe(true)
    const line = outcomeLine(
      provided([
        { environment: "production", exitCode: 0 },
        { environment: "preview", exitCode: null },
      ]),
    )
    expect(line).toBe("Provided · production ✓ · preview ✗ stopped by a signal")
    expect(needsYou(provided([]))).toBe(false)
  })

  test("is done once every environment took it, failed while any did not, sending until its sink ran", () => {
    expect(itemState(provided([{ environment: "production", exitCode: 0 }]))).toBe("done")
    expect(itemState(provided([{ environment: "production", exitCode: 1 }]))).toBe("failed")
    expect(itemState(provided())).toBe("sending")
  })

  test("a saved secret its poster was not told of still reads provided, with the failed telling as a note of its own that offers Retry (PG-880)", () => {
    const untold = {
      ...provided([{ environment: "Keychain", exitCode: 0, line: "saved" } as never]),
      delivery: {
        code: "SESSIONS_FAILED",
        reason:
          "The sessions read was cut short (a herdr server or pane did not answer whole), so dispatcher was not found; nothing was typed.",
        status: "failed",
      },
      from: "dispatcher",
    } as InboxItem
    expect(itemState(untold)).toBe("done")
    expect(inboxLight(untold)).toBe("done")
    expect(outcomeLine(untold)).toBe("Provided · Keychain ✓")
    expect(deliveryNote(untold)).toStartWith("Not told to ")
    expect(deliveryNote(untold)).toContain("cut short")
    expect(retryable(untold)).toBe(true)
    expect(
      itemState({
        ...untold,
        answer: { ...untold.answer, results: [{ environment: "Keychain", exitCode: 1 }] },
      } as InboxItem),
    ).toBe("failed")
    expect(deliveryNote(provided([{ environment: "production", exitCode: 0 }]))).toBeNull()
  })
})

describe("an accept decision (PG-658)", () => {
  const preview = {
    key: "end-of-day",
    kind: "skill",
    rev: "3f9a2c1d",
    scope: "acme",
    type: "accept",
    why: "Scored 4 by two reviewers",
  }
  const asked = item({ kind: "decision", preview } as never)
  const approved = (accepted?: { exitCode: number; line: string }) =>
    item({
      answer: { accepted, at: "2026-11-03T20:00:00.000Z", choice: "approve" },
      delivery: { at: "x", status: "delivered", via: "session" },
      kind: "decision",
      preview,
      status: "approved",
    } as never)

  test("needs you while open, and reads as an accept", () => {
    expect(kindWord(asked)).toBe("Accept")
    expect(needsYou(asked)).toBe(true)
  })

  test("once approved, reads what the dashboard's accept gave, done or failed by its exit code", () => {
    const ran = approved({ exitCode: 0, line: "rev 9b8c7d6 is accepted" })
    expect(outcomeLine(ran)).toBe(
      "Approve · Accept the skill end-of-day · Accepted: rev 9b8c7d6 is accepted",
    )
    expect(itemState(ran)).toBe("done")
    const refused = approved({ exitCode: 1, line: "409 the proposal is at 0a1b2c3d4e5f" })
    expect(outcomeLine(refused)).toBe(
      "Approve · Accept the skill end-of-day · Accept failed (exit 1): 409 the proposal is at 0a1b2c3d4e5f",
    )
    expect(itemState(refused)).toBe("failed")
  })

  test("an accept its poster was not told of says why beside the result", () => {
    const unsent = item({
      ...approved({ exitCode: 0, line: "rev 9b8c7d6 is accepted" }),
      delivery: { code: "SESSIONS_FAILED", reason: "cmux is not running", status: "failed" },
    } as never)
    expect(outcomeLine(unsent)).toBe(
      "Approve · Accept the skill end-of-day · Accepted: rev 9b8c7d6 is accepted · Send failed: cmux is not running",
    )
    expect(itemState(unsent)).toBe("failed")
  })
})

describe("a guard decision (PG-1090)", () => {
  const guard = {
    key: "slack.gatedSends",
    scope: "acme-test",
    type: "guard",
    value: { path: "/made/up/send", selfDm: "D0MADEUP1", servers: ["made-up-slack"] },
    why: "Back the org's no-Slack-writes guard",
  }
  const approved = (preview: object, set: object) =>
    item({
      answer: { at: "2026-11-06T03:00:00.000Z", choice: "approve", set },
      delivery: { at: "x", status: "delivered", via: "session" },
      kind: "decision",
      preview,
      status: "approved",
    } as never)

  test("needs you while open, and reads Guard setting", () => {
    const asked = item({ kind: "decision", preview: guard } as never)
    expect(kindWord(asked)).toBe("Guard setting")
    expect(needsYou(asked)).toBe(true)
  })

  test("reads the line the dashboard wrote, done or failed by its exit code", () => {
    const ran = approved(guard, { exitCode: 0, line: "set slack.gatedSends at acme-test to {}" })
    expect(outcomeLine(ran)).toBe(
      "Approve · Set slack.gatedSends · Guard setting: set slack.gatedSends at acme-test to {}",
    )
    expect(itemState(ran)).toBe("done")
    const { value: _, ...cleared } = guard
    const refused = approved(cleared, {
      exitCode: 1,
      line: "slack.gatedSends has no value at acme-test: it is at its default",
    })
    expect(outcomeLine(refused)).toBe(
      "Approve · Take slack.gatedSends back to its default · Guard setting failed (exit 1): slack.gatedSends has no value at acme-test: it is at its default",
    )
    expect(itemState(refused)).toBe("failed")
  })
})

describe("an own decision (PG-1162)", () => {
  const own = {
    key: "pat@example.com",
    own: true,
    scope: "made-up-me",
    type: "own",
    why: "Spend the org's accounts first",
  }
  const approved = (preview: object, owned: object) =>
    item({
      answer: { at: "2026-11-06T03:00:00.000Z", choice: "approve", owned },
      delivery: { at: "x", status: "delivered", via: "session" },
      kind: "decision",
      preview,
      status: "approved",
    } as never)

  test("needs you while open, and reads Own account", () => {
    const asked = item({ kind: "decision", preview: own } as never)
    expect(kindWord(asked)).toBe("Own account")
    expect(needsYou(asked)).toBe(true)
  })

  test("reads the line the dashboard wrote, done or failed by its exit code", () => {
    const ran = approved(own, {
      exitCode: 0,
      line: "pat@example.com is now your own account at made-up-me",
    })
    expect(outcomeLine(ran)).toBe(
      "Approve · Mark pat@example.com as your own account · Own account: pat@example.com is now your own account at made-up-me",
    )
    expect(itemState(ran)).toBe("done")
    const gone = approved(
      { ...own, own: false },
      { exitCode: 1, line: "pat@example.com is no longer in usage.accounts at made-up-me" },
    )
    expect(outcomeLine(gone)).toBe(
      "Approve · Unmark pat@example.com as your own account · Own account change failed (exit 1): pat@example.com is no longer in usage.accounts at made-up-me",
    )
    expect(itemState(gone)).toBe("failed")
  })
})

describe("an apps decision and a grant decision (PG-658)", () => {
  const apps = { app: "Notes", change: "add", type: "apps", why: "It holds your notes" }
  const grant = { permission: "accessibility", type: "grant", why: "It drives Notes" }
  const approved = (preview: object, step: object, rest: object = {}) =>
    item({
      answer: { at: "2026-11-03T20:00:00.000Z", choice: "approve", ...step },
      delivery: { at: "x", status: "delivered", via: "session" },
      kind: "decision",
      preview,
      status: "approved",
      ...rest,
    } as never)

  test("each needs you while open, and reads by what Approve does", () => {
    const asked = item({ kind: "decision", preview: apps } as never)
    expect(kindWord(asked)).toBe("Your apps")
    expect(needsYou(asked)).toBe(true)
    expect(kindWord(item({ kind: "decision", preview: grant } as never))).toBe("Permission")
  })

  test("an apps change reads the list the dashboard wrote, done or failed by its exit code", () => {
    const ran = approved(apps, {
      listed: { exitCode: 0, line: "added Notes; your apps are Notes" },
    })
    expect(outcomeLine(ran)).toBe(
      "Approve · Add Notes · Your apps: added Notes; your apps are Notes",
    )
    expect(itemState(ran)).toBe("done")
    const refused = approved(apps, {
      listed: { exitCode: 1, line: "Notes is not on your own apps list, so nothing changed" },
    })
    expect(outcomeLine(refused)).toBe(
      "Approve · Add Notes · Apps change failed (exit 1): Notes is not on your own apps list, so nothing changed",
    )
    expect(itemState(refused)).toBe("failed")
  })

  test("a grant that opened its pane waits on its poster's recheck, and one that opened nothing failed", () => {
    const opened = {
      opened: { exitCode: 0, line: "opened System Settings at Privacy & Security > Accessibility" },
    }
    const waiting = approved(grant, opened)
    expect(outcomeLine(waiting)).toBe(
      "Approve · Open the accessibility settings · Opened System Settings at Privacy & Security > Accessibility",
    )
    expect(itemState(waiting)).toBe("sending")
    const rechecked = approved(grant, {
      ...opened,
      ackedAt: "2026-11-03T20:02:00.000Z",
      noLink: "granted",
    })
    expect(itemState(rechecked)).toBe("done")
    const failed = approved(grant, { opened: { exitCode: 1, line: "LSOpenURLsWithRole() failed" } })
    expect(outcomeLine(failed)).toBe(
      "Approve · Open the accessibility settings · Opening System Settings failed (exit 1): LSOpenURLsWithRole() failed",
    )
    expect(itemState(failed)).toBe("failed")
  })
})

describe("the inbox's counts", () => {
  test("what needs you: open decisions and drafts, and unread updates", () => {
    expect(items.filter(needsYou).map((i) => i.ref)).toEqual([41, 40, 44])
    expect(inboxWaiting(items)).toEqual(["id-41", "id-40", "id-44"])
    expect(inboxSummary(items)).toBe("1 needs you · 1 draft · 1 unread")
    expect(inboxSummary([items[3]!, items[4]!])).toBeNull()
  })

  test("the kind as the meta line words it", () => {
    expect(items.map(kindWord)).toEqual(["Ship", "Slack draft", "Merged", "Merged", "Ship"])
    expect(kindWord(item({ kind: "decision", preview: { text: "x", type: "ask" } } as never))).toBe(
      "Ask",
    )
  })

  test("a go taken by the session that stood in for an ended poster reads its pick alone, its taker named only while the answer is queued", () => {
    const taken = {
      ...items[4]!,
      delivery: { at: "x", status: "delivered", to: "dispatcher", via: "session" },
    } as InboxItem
    expect(outcomeLine(taken)).toBe("Approve · Ship 3f9a2c1 to main")
    expect(
      outcomeLine({
        ...taken,
        answer: { ackedAt: "y", at: "x", choice: "approve", noLink: "a budget has no page" },
      } as InboxItem),
    ).toBe("Approve · Ship 3f9a2c1 to main · No link: a budget has no page")
    expect(
      outcomeLine({
        ...items[4]!,
        delivery: { at: "x", status: "delivered", to: "ops", via: "session" },
      }),
    ).toBe("Approve · Ship 3f9a2c1 to main")
  })

  test("an answered item says what he chose, and a state only where the answer did not simply go through (#1013)", () => {
    expect(outcomeLine(items[0]!)).toBeNull()
    // a go names its pick alone while its poster carries it out, which its light says, until its poster closes it with a link or why there is none
    expect(outcomeLine({ ...items[4]!, delivery: { status: "pending" } })).toBe(
      "Approve · Ship 3f9a2c1 to main",
    )
    expect(
      outcomeLine({ ...items[4]!, delivery: { at: "x", status: "delivered", via: "session" } }),
    ).toBe("Approve · Ship 3f9a2c1 to main")
    expect(
      outcomeLine({
        ...items[4]!,
        answer: { ackedAt: "y", at: "x", choice: "approve", noLink: "a budget has no page" },
        delivery: { at: "x", status: "delivered", via: "cli" },
      } as InboxItem),
    ).toBe("Approve · Ship 3f9a2c1 to main · No link: a budget has no page")
    // an approved Slack message is sent, as a draft is
    expect(
      outcomeLine({
        ...items[4]!,
        preview: {
          link: "https://app.slack.com/client/T0/C0",
          text: "hi",
          to: "@Merritt",
          type: "slack",
        },
      } as InboxItem),
    ).toBe("Approve · Send it to @Merritt")
    // a deny is carried out by reading it
    expect(
      outcomeLine({
        ...items[4]!,
        answer: { at: "x", choice: "deny" },
        delivery: { at: "x", status: "delivered", via: "cli" },
        status: "denied",
      } as InboxItem),
    ).toBe("Deny · Hold the ship")
    // a clear archives it, read by its poster as a deny is, and is never carried out (PG-654: Archived and when)
    const archivedAt = "2026-10-07T11:00:00.000Z"
    expect(
      outcomeLine({
        ...items[4]!,
        answer: { at: archivedAt, choice: "clear" },
        delivery: { at: "x", status: "delivered", via: "cli" },
        status: "cleared",
      } as InboxItem),
    ).toBe(`Archived ${fullTime(archivedAt)}`)
    expect(
      outcomeLine({
        ...items[4]!,
        delivery: { code: "ON_PICKER", reason: "busy", status: "failed" },
      }),
    ).toBe("Approve · Ship 3f9a2c1 to main · Send failed: busy")
  })
})

describe("a session waiting on an item it posted", () => {
  test("waits on its oldest open decision or draft, never an update or an answered one", () => {
    expect(inboxWaitOf(items, "ops")).toEqual({ id: "id-41", ref: 41 })
    expect(inboxWaitOf(items, "dispatcher")).toEqual({ id: "id-40", ref: 40 })
    expect(inboxWaitOf(items, "builder")).toBeNull()
    expect(inboxPosters(items)).toEqual(new Set(["ops", "dispatcher"]))
  })
})

describe("a link to an item", () => {
  test("names an item the inbox holds, so the view opens its Inbox tab", () => {
    expect(inboxTarget("needs-you-id-41", items)).toBe(true)
    expect(inboxTarget("needs-you-feed-abc", items)).toBe(false)
    expect(inboxTarget("id-41", items)).toBe(false)
  })

  test("opens the Done shelf only for a click: a page loaded with a Done card's hash starts with it shut", () => {
    const shelves = [
      ["progress", null, []],
      ["done", null, [items[4]!]],
    ] as const
    const anchor = `needs-you-${items[4]!.id}`
    expect(shelfToOpen(anchor, "link", shelves, [])).toBeNull()
    expect(shelfToOpen(anchor, "click", shelves, [])).toBe("done")
    expect(shelfToOpen(anchor, "click", shelves, ["done"])).toBeNull()
    expect(shelfToOpen("needs-you-id-41", "click", shelves, [])).toBeNull()
  })
})

describe("a probe's items", () => {
  test("wait on its spawner, never Merritt: no Waiting on you and no rank among the waiting", () => {
    const probeItems = [item({ from: "probe-history", kind: "decision", ref: 50 })]
    expect(inboxWaitOf(probeItems, "probe-history")).toBeNull()
    expect(inboxPosters(probeItems)).toEqual(new Set())
  })
})

describe("inboxView", () => {
  const NOW = Date.parse("2026-10-07T12:00:00.000Z")
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const answered = (ref: number, at: string) =>
    item({ answer: { at, choice: "approve" }, kind: "decision", ref, status: "approved" })
  const read = (ref: number, at: string) => item({ kind: "update", readAt: at, ref })

  // the owner's ask on the new Inbox: a card moves when a verb moves it, never by a clock
  test("an approved card its poster has not closed stays In progress past ten minutes, until its ack moves it to Done", () => {
    const go = answered(12, ago(60 * 60_000))
    expect(inboxView([go])).toEqual({ archived: [], done: [], progress: [go], shown: [] })
    const acked = item({
      answer: {
        ackedAt: ago(1_000),
        at: ago(60 * 60_000),
        choice: "approve",
        dismissedAt: ago(1_000),
      },
      kind: "decision",
      ref: 12,
      status: "approved",
    })
    expect(inboxView([acked])).toEqual({ archived: [], done: [acked], progress: [], shown: [] })
  })

  test("a card he only commented on stays waiting in the list past five minutes, until its poster closes it", () => {
    const replied = item({
      answer: { at: ago(60 * 60_000), choice: "replied" },
      kind: "decision",
      ref: 42,
    })
    expect(inboxView([replied])).toEqual({ archived: [], done: [], progress: [], shown: [replied] })
  })

  test("a read update stays in the list until he dismisses it, and one read before the clocks stopped is in Done", () => {
    const after = (ms: number) => new Date(Date.parse(CLOCKS_STOPPED_AT) + ms).toISOString()
    const before = read(30, after(-60_000))
    const since = read(31, after(60 * 60_000))
    const dismissed = item({
      answer: { dismissedAt: after(2 * 60 * 60_000) },
      kind: "update",
      readAt: after(60_000),
      ref: 32,
    })
    const { done, shown } = inboxView([before, since, dismissed])
    expect(shown.map((i) => i.ref)).toEqual([31])
    expect(done.map((i) => i.ref)).toEqual([32, 30])
  })

  test("a read update woken from Later stays in the list until he presses Done or Dismiss, as one never put off does", () => {
    const after = (ms: number) => new Date(Date.parse(CLOCKS_STOPPED_AT) + ms).toISOString()
    const woken = item({
      answer: { snoozedUntil: after(2 * 60_000) },
      kind: "update",
      readAt: after(60_000),
      ref: 33,
    })
    const dismissed = item({
      answer: { dismissed: true, dismissedAt: after(3 * 60_000), snoozedUntil: after(2 * 60_000) },
      kind: "update",
      readAt: after(60_000),
      ref: 34,
    })
    const { done, shown } = inboxView([woken, dismissed])
    expect(shown.map((i) => i.ref)).toEqual([33])
    expect(done.map((i) => i.ref)).toEqual([34])
  })

  test("a no-go goes to Done once answered, and Done lists the newest settled first while an open item or an unread update stays", () => {
    const denied = (ref: number, at: string) =>
      item({ answer: { at, choice: "deny" }, kind: "decision", ref, status: "denied" })
    const list = [
      denied(5, ago(3 * 60 * 60_000)),
      denied(6, ago(60_000)),
      denied(7, ago(60 * 60_000)),
      item({ kind: "update", ref: 8, updatedAt: ago(9 * 60 * 60_000) }),
      item({ kind: "draft", ref: 9, createdAt: ago(9 * 60 * 60_000) }),
    ]
    const { done, shown } = inboxView(list)
    expect(done.map((i) => i.ref)).toEqual([6, 7, 5])
    expect(shown.map((i) => i.ref)).toEqual([8, 9])
  })

  test("a set-aside item goes to Archive at once, newest first, never to the list or Done", () => {
    const cleared = (ref: number) =>
      item({
        answer: { at: ago(60_000), choice: "clear" },
        kind: "decision",
        ref,
        status: "cleared",
      })
    const { archived, done, shown } = inboxView([
      cleared(3),
      item({ kind: "decision", ref: 50 }),
      cleared(7),
      item({
        answer: { at: ago(30 * 60_000), choice: "deny" },
        kind: "decision",
        ref: 11,
        status: "denied",
      }),
    ])
    expect(archived.map((i) => i.ref)).toEqual([7, 3])
    expect(shown.map((i) => i.ref)).toEqual([50])
    expect(done.map((i) => i.ref)).toEqual([11])
  })

  test("a set-aside item he dismissed leaves Archive for Done", () => {
    const dismissed = item({
      answer: { at: ago(120_000), choice: "clear", dismissedAt: ago(60_000) },
      kind: "decision",
      ref: 4,
      status: "cleared",
    })
    const { archived, done } = inboxView([dismissed])
    expect(archived).toEqual([])
    expect(done.map((i) => i.ref)).toEqual([4])
  })

  // a reviewer: a set-aside whose send failed went to the shut shelf while the API still counted it
  test("a set-aside whose send failed stays in the list and its count, offering Retry, until it reaches its poster or he dismisses it", () => {
    const failedClear = item({
      answer: { at: ago(120_000), choice: "clear" },
      delivery: { code: "ON_PICKER", reason: "waiting on a picker", status: "failed" },
      kind: "decision",
      ref: 5,
      status: "cleared",
    })
    expect(sendFailed(failedClear)).toBe(true)
    const { archived, shown } = inboxView([failedClear])
    expect(archived).toEqual([])
    expect(shown.map((i) => i.ref)).toEqual([5])
  })

  test("a new item arriving goes above Done, in the list", () => {
    const { done, shown } = inboxView([
      item({
        answer: { at: ago(30 * 60_000), choice: "deny" },
        kind: "decision",
        ref: 11,
        status: "denied",
      }),
      item({ kind: "decision", ref: 50 }),
    ])
    expect(shown.map((i) => i.ref)).toEqual([50])
    expect(done.map((i) => i.ref)).toEqual([11])
  })
})

describe("Dismiss", () => {
  const NOW = Date.parse("2026-10-07T12:00:00.000Z")
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const answered = (ref: number, dismissed?: string) =>
    item({
      answer: {
        at: ago(60_000),
        choice: "approve",
        ...(dismissed ? { dismissedAt: dismissed } : {}),
      },
      kind: "decision",
      ref,
      status: "approved",
    })

  test("a dismissed item goes to Done at once, newest dismissed first", () => {
    const { done, progress } = inboxView([
      answered(23),
      answered(22, ago(120_000)),
      answered(21, ago(30_000)),
    ])
    expect(done.map((i) => i.ref)).toEqual([21, 22])
    expect(progress.map((i) => i.ref)).toEqual([23])
  })

  test("is offered on an answered decision or draft and on any update still in the list, never on an open decision or draft", () => {
    expect(dismissable(answered(1))).toBe(true)
    expect(dismissable(answered(1, ago(1)))).toBe(false)
    expect(dismissable(item({ kind: "decision" }))).toBe(false)
    expect(dismissable(item({ kind: "draft" }))).toBe(false)
    expect(dismissable(item({ kind: "update" }))).toBe(true)
    expect(dismissable(item({ kind: "update", readAt: ago(1) }))).toBe(true)
    expect(
      dismissable(item({ answer: { dismissedAt: ago(1) }, kind: "update", readAt: ago(1) })),
    ).toBe(false)
  })

  // An item answered from chat can still be dismissed.
  test("is offered on a decision or draft he replied to in chat, still open, until it is dismissed", () => {
    const replied = { at: ago(60_000), choice: "replied" as const }
    expect(dismissable(item({ answer: replied, kind: "decision" }))).toBe(true)
    expect(dismissable(item({ answer: replied, kind: "draft" }))).toBe(true)
    expect(
      dismissable(item({ answer: { ...replied, dismissedAt: ago(1) }, kind: "decision" })),
    ).toBe(false)
  })

  test("a replied item he dismissed goes to Done at once, its poster not done with it yet", () => {
    const dismissed = item({
      answer: { at: ago(60_000), choice: "replied", dismissedAt: ago(1_000) },
      kind: "decision",
      ref: 31,
    })
    const waiting = item({
      answer: { at: ago(60_000), choice: "replied" },
      kind: "decision",
      ref: 32,
    })
    const { done, shown } = inboxView([dismissed, waiting])
    expect(done.map((i) => i.ref)).toEqual([31])
    expect(shown.map((i) => i.ref)).toEqual([32])
  })

  test("a dismissed update goes to Done at once, with no outcome or link of an answer", () => {
    const update = item({
      answer: { dismissedAt: ago(1_000) },
      kind: "update",
      readAt: ago(1_000),
      ref: 9,
    })
    expect(inboxView([update]).done.map((i) => i.ref)).toEqual([9])
    expect(outcomeLine(update)).toBeNull()
    expect(resultLink(update)).toBeNull()
  })

  // Mark as read keeps the message as it is and drops the double tick.
  test("an open ask marked read stays in the list as it is, still waiting on an answer, however long ago", () => {
    const seen = item({ kind: "decision", readAt: ago(6 * 60 * 60_000), ref: 8 })
    expect(inboxView([seen]).shown).toEqual([seen])
    expect(needsYou(seen)).toBe(true)
    expect(outcomeLine(seen)).toBeNull()
  })
})

// PG-1074: a shelf's row does what its place says, whatever words it shows.
describe("a shelf's row, by its place", () => {
  const read = item({ answer: { dismissedAt: "2026-10-07T11:00:00.000Z" }, kind: "update", ref: 2 })
  const unread = item({ kind: "update", ref: 3 })
  const waiting = item({ kind: "decision", ref: 4 })

  test("Archive's one click dismisses each card in turn, a waiting ask included", () => {
    expect(shelfRow("archived", [waiting, unread])).toEqual({
      bulk: { each: true, ids: ["id-4", "id-3"] },
      muted: false,
    })
  })

  test("Done's one click marks what is unread on it as read, and the row reads muted once none is", () => {
    expect(shelfRow("done", [read, unread])).toEqual({
      bulk: { each: false, ids: ["id-3"] },
      muted: false,
      unread: 1,
    })
    expect(shelfRow("done", [read])).toEqual({
      bulk: { each: false, ids: [] },
      muted: true,
      unread: 0,
    })
  })

  test("In progress and Later have no one click and never read muted", () => {
    for (const place of ["progress", "snoozed"] as const)
      expect(shelfRow(place, [waiting, unread])).toEqual({ bulk: null, muted: false })
  })

  test("an empty shelf has no one click", () => {
    for (const place of ["archived", "done", "progress", "snoozed"] as const)
      expect(shelfRow(place, []).bulk).toBeNull()
  })

  test("each place keeps its words: In progress, Later, Archive and Done", () => {
    expect(SHELF_LABELS).toEqual({
      archived: "Archive",
      done: "Done",
      progress: "In progress",
      snoozed: "Later",
    })
  })
})

describe("a settled item", () => {
  const settled = item({
    answer: {
      at: "2026-10-07T11:00:00.000Z",
      by: "dispatcher",
      choice: "settled",
      note: "Shipped by hand",
    },
    kind: "decision",
    ref: 4,
    status: "done",
  })

  test("reads Decided by its poster with the note, offers no answer, and can be dismissed", () => {
    expect(outcomeLine(settled)).toBe("Decided by Alpha · Shipped by hand")
    expect(
      outcomeLine({
        ...settled,
        answer: { at: "x", by: "builder", choice: "settled" },
        kind: "decision",
      } as InboxItem),
    ).toBe("Decided by Builder")
    expect(needsYou(settled)).toBe(false)
    expect(dismissable(settled)).toBe(true)
  })
})

describe("an item he replied to in chat", () => {
  const replied = item({
    answer: { at: "2026-10-07T11:30:00.000Z", choice: "replied" },
    kind: "decision",
    ref: 42,
  })
  const acked = item({
    answer: {
      at: "2026-10-07T11:30:00.000Z",
      ackedAt: "2026-10-07T12:30:00.000Z",
      choice: "replied",
      link: "https://github.com/acme/archive/pull/270",
    },
    kind: "decision",
    ref: 42,
  })

  test("a reply takes it off the count, the summary and the waiting, but it stays in the list, where Dismiss clears it", () => {
    expect(needsYou(replied)).toBe(false)
    const list = [...items, replied]
    expect(inboxSummary(list)).toBe(inboxSummary(items))
    expect(inboxWaiting(list)).toEqual(inboxWaiting(items))
    expect(inboxWaitOf(list, "ops")).toEqual(inboxWaitOf(items, "ops"))
    expect(inboxPosters(list)).toEqual(inboxPosters(items))
    expect(dismissable(replied)).toBe(true)
  })

  // The row above reads a poster that holds another open item, which hides the replied exclusion; this one reads a poster with nothing else open.
  test("a poster with nothing else open is nowhere for a replied item: no waiting item, out of the posters", () => {
    const solo = item({
      answer: { at: "2026-10-07T11:30:00.000Z", choice: "replied" },
      from: "worker-wrath",
      kind: "decision",
      ref: 77,
    })
    expect(inboxWaitOf([solo], "worker-wrath")).toBeNull()
    expect(inboxPosters([solo]).has("worker-wrath")).toBe(false)
    // one still-open item of the same poster's holds the waiting and the posters, and the replied one never does
    const open = item({ from: "worker-wrath", kind: "decision", ref: 78 })
    expect(inboxWaitOf([open], "worker-wrath")).toEqual({ id: open.id, ref: 78 })
    expect(inboxPosters([open]).has("worker-wrath")).toBe(true)
    expect(inboxWaitOf([solo, open], "worker-wrath")).toEqual({ id: open.id, ref: 78 })
    expect(inboxPosters([solo, open]).has("worker-wrath")).toBe(true)
  })

  test("a reply the poster read by cli stays open until its ack, while a deny read that way closes", () => {
    const cliRead = item({
      answer: { at: "2026-10-13T11:30:00.000Z", choice: "replied" },
      delivery: { at: "x", status: "delivered", via: "cli" },
      kind: "decision",
      ref: 42,
    })
    expect(itemState(cliRead)).toBe("sending")
    const denied = item({
      answer: { at: "2026-10-13T11:30:00.000Z", choice: "deny" },
      delivery: { at: "x", status: "delivered", via: "cli" },
      kind: "decision",
      ref: 43,
      status: "denied",
    })
    expect(itemState(denied)).toBe("closed")
  })

  test("reads being worked on by its poster with the working light, then done once the poster closed it", () => {
    expect(itemState(replied)).toBe("sending")
    expect(outcomeLine(replied)).toBe("You replied")
    // his words lead once recorded, so the action in progress shows
    expect(
      outcomeLine(item({ ...replied, answer: { ...replied.answer, said: "tomorrow" } as never })),
    ).toBe('You: "tomorrow"')
    expect(inboxLight(replied)).toBe("working")
    expect(itemState(acked)).toBe("done")
    expect(outcomeLine(acked)).toBe("You replied")
    expect(inboxLight(acked)).toBe("done")
    // the poster's close links where it landed
    expect(resultLink(acked)).toEqual({
      href: "https://github.com/acme/archive/pull/270",
      label: "acme/archive#270",
    })
  })

  test("stays in the list, still waiting on his answer, while its poster works, and moves to Done once it is closed", () => {
    expect(inboxView([replied]).shown.map((i) => i.ref)).toEqual([42])
    expect(inboxView([replied]).progress).toEqual([])
    expect(inboxView([acked]).done.map((i) => i.ref)).toEqual([42])
  })
})

describe("resultLink", () => {
  const APP =
    "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
  const sent = (link?: string, linkLabel?: string) =>
    item({
      answer: {
        at: "x",
        choice: "send",
        ...(link ? { link } : {}),
        ...(linkLabel ? { linkLabel } : {}),
      },
      kind: "draft",
      status: "sent",
    })

  test("names the link by what was carried out: the poster's label first", () => {
    expect(
      resultLink(sent("https://linear.app/acme/issue/MADEDUNE-2186/x", "Filed MADEDUNE-2186")),
    ).toEqual({
      href: "https://linear.app/acme/issue/MADEDUNE-2186/x",
      label: "Filed MADEDUNE-2186",
    })
  })

  test("else draws the name from the link: Open thread for Slack, a Linear ID, owner/repo#N, or the site", () => {
    // Slack links take the app client form, https://app.slack.com/client
    // the words a draft's own link uses, such as open thread
    expect(resultLink(sent(APP))).toEqual({ href: APP, label: "Open thread" })
    // a label the poster gave still wins, as for any link, so the documented Slack ack passes none
    expect(resultLink(sent(APP, "Replied to Merritt"))?.label).toBe("Replied to Merritt")
    expect(resultLink(sent("https://app.slack.com/client/T0000000000/C0MADEUP01"))?.label).toBe(
      "Open thread",
    )
    expect(
      resultLink(sent("https://linear.app/acme/issue/madedune-2186/export-times-out"))?.label,
    ).toBe("MADEDUNE-2186")
    expect(resultLink(sent("https://github.com/acme/gke-deployments/pull/1083"))?.label).toBe(
      "acme/gke-deployments#1083",
    )
    expect(resultLink(sent("https://github.com/acme/app/issues/4186"))?.label).toBe("acme/app#4186")
    expect(resultLink(sent("https://example.com/x"))?.label).toBe("example.com")
  })

  test("is null without a link or for one that is not https", () => {
    expect(resultLink(sent())).toBeNull()
    expect(resultLink(sent("http://app.slack.com/client/T0000000000/C0MADEUP01"))).toBeNull()
    expect(resultLink(sent("javascript:alert(1)"))).toBeNull()
  })
})

describe("a draft's thread", () => {
  const draft = (link?: string) =>
    item({
      kind: "draft",
      preview: { text: "hi", to: "Cameron's thread", ...(link ? { link } : {}) },
    })
  const SLACK =
    "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
  const LINEAR = "https://linear.app/acme/issue/MADEDUNE-2186/export-times-out"

  test("its label comes from where its link points: a Linear comment, else a Slack draft", () => {
    expect(kindWord(draft(LINEAR))).toBe("Linear comment")
    expect(kindWord(draft(SLACK))).toBe("Slack draft")
    expect(kindWord(draft())).toBe("Slack draft")
  })

  test("its link opens the thread, https alone", () => {
    expect(upfrontLink(draft(SLACK))).toEqual({ href: SLACK, label: "Open thread" })
    expect(upfrontLink(draft(LINEAR))).toEqual({ href: LINEAR, label: "Open thread" })
    expect(upfrontLink(draft())).toBeNull()
    expect(upfrontLink(draft("http://linear.app/acme/issue/MADEDUNE-1"))).toBeNull()
    expect(upfrontLink(draft("javascript:alert(1)"))).toBeNull()
  })

  test("a slack, ship or ticket decision shows where it lands upfront, or why it cannot yet", () => {
    // The link to where a reply goes comes first, not after the draft
    const decision = (preview: object) => item({ kind: "decision", preview } as never)
    const ship = { prs: [{ number: 1, title: "x" }], sha: "3f9a2c1", type: "ship" }
    const compare = "https://github.com/acme/app/compare/main...3f9a2c1"
    expect(upfrontLink(decision({ ...ship, link: compare }))).toEqual({
      href: compare,
      label: "acme/app compare",
    })
    expect(
      upfrontLink(decision({ link: SLACK, text: "hi", to: "@Merritt", type: "slack" })),
    ).toEqual({
      href: SLACK,
      label: "Open thread",
    })
    expect(
      upfrontLink(
        item({ kind: "draft", preview: { noLink: "a new DM", text: "hi", to: "@Merritt" } }),
      ),
    ).toEqual({ reason: "a new DM" })
    expect(upfrontLink(decision({ amount: "$4", type: "budget", why: "x" }))).toBeNull()
    expect(upfrontLink(item({ kind: "decision" }))).toBeNull()
  })

  test("the ack's link replaces the upfront one", () => {
    expect(
      upfrontLink(
        item({
          answer: { at: "x", choice: "send", link: LINEAR },
          kind: "draft",
          preview: { link: SLACK, text: "hi", to: "@Merritt" },
          status: "sent",
        }),
      ),
    ).toBeNull()
  })
})

describe("an answer that failed to send", () => {
  const NOW = Date.parse("2026-10-09T12:00:00.000Z")
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const failed = (ref: number, dismissed?: string) =>
    item({
      answer: {
        at: ago(60 * 60_000),
        choice: "send",
        ...(dismissed ? { dismissedAt: dismissed } : {}),
      },
      delivery: { code: "SESSIONS_FAILED", reason: "no answer from cmux", status: "failed" },
      kind: "draft",
      ref,
      status: "sent",
    })

  test("stays in the list as needing you, however long ago, saying the send failed", () => {
    const item = failed(76)
    expect(sendFailed(item)).toBe(true)
    expect(needsYou(item)).toBe(true)
    expect(inboxView([item])).toEqual({ archived: [], done: [], progress: [], shown: [item] })
    expect(outcomeLine(item)).toBe("Sent · Send failed: no answer from cmux")
    expect(inboxSummary([item])).toBe("1 failed to send")
  })

  test("offers its own Dismiss", () => {
    expect(dismissable(failed(76))).toBe(true)
  })

  test("offers Retry only where nothing was typed, and reads as unconfirmed where typing may have begun", () => {
    expect(RETRY_CODES).toEqual(API_RETRY_CODES)
    expect(retryable(failed(76))).toBe(true)
    for (const code of ["INTERRUPTED", "ERROR"]) {
      const cut = {
        ...failed(77),
        delivery: { code, reason: "cut off", status: "failed" as const },
      }
      expect(sendFailed(cut), code).toBe(true)
      expect(retryable(cut), code).toBe(false)
      expect(outcomeLine(cut), code).toMatch(
        /^Sent · Send unconfirmed: whether \S+ has it is not known$/,
      )
    }
    expect(retryable(failed(78, ago(1_000)))).toBe(false)
  })

  test("once he dismisses it, goes to Done and asks nothing more", () => {
    const item = failed(76, ago(1_000))
    expect(sendFailed(item)).toBe(false)
    expect(needsYou(item)).toBe(false)
    expect(inboxView([item]).done.map((i) => i.ref)).toEqual([76])
  })
})

describe("a sent draft before its poster acks it", () => {
  const sent = (over: Partial<InboxItem>) =>
    item({
      answer: { at: "x", choice: "send" },
      kind: "draft",
      status: "sent",
      ...over,
    } as Partial<InboxItem> & Pick<InboxItem, "kind">)

  test("reads Sent, its light still sending even once typed into the session (#i115 read Delivered before Slack had it)", () => {
    const typed = { at: "x", status: "delivered", via: "session" } as const
    expect(outcomeLine(sent({ delivery: typed }))).toBe("Sent")
    expect(itemState(sent({ delivery: typed }))).toBe("sending")
    expect(outcomeLine(sent({ delivery: { status: "pending" } }))).toBe("Sent")
    expect(outcomeLine(sent({ answer: { at: "x", choice: "send", editedText: "hey" } }))).toBe(
      "Sent with your changes",
    )
    expect(
      outcomeLine(
        sent({
          delivery: typed,
          preview: { link: "https://linear.app/acme/issue/MADEDUNE-1/x", text: "hi", to: "Cam" },
        }),
      ),
    ).toBe("Sent")
  })

  test("reads as it did once acked, its link opening the thread", () => {
    const link =
      "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
    const acked = sent({
      answer: { ackedAt: "y", at: "x", choice: "send", link },
      delivery: { at: "x", status: "delivered", via: "session" },
    })
    expect(outcomeLine(acked)).toBe("Sent")
    expect(resultLink(acked)).toEqual({ href: link, label: "Open thread" })
    // read through bun run ask, which closed a go only before acks were stamped
    expect(outcomeLine(sent({ delivery: { at: "x", status: "delivered", via: "cli" } }))).toBe(
      "Sent",
    )
    expect(
      outcomeLine(
        sent({
          answer: { at: "2026-10-11T10:00:00.000Z", choice: "send" },
          delivery: { at: "x", status: "delivered", via: "cli" },
        }),
      ),
    ).toBe("Sent")
    // typed into its session before then, which the API's stale read no longer chases
    expect(
      outcomeLine(
        sent({
          answer: { at: "2026-10-11T10:00:00.000Z", choice: "send" },
          delivery: { at: "x", status: "delivered", via: "session" },
        }),
      ),
    ).toBe("Sent")
    expect(ACKS_STAMPED_FROM).toBe(API_ACKS_STAMPED_FROM.toISOString())
    // the web restates which answers are gos and which decisions name a place; the API's decide
    expect(GO_CHOICES).toEqual(API_GO_CHOICES)
    expect(PLACED_TYPES).toEqual(API_PLACED_TYPES)
    // acked with a link before acks were stamped
    expect(
      outcomeLine(
        sent({
          answer: { at: "x", choice: "send", link },
          delivery: { at: "x", status: "delivered", via: "session" },
        }),
      ),
    ).toBe("Sent")
  })
})

describe("a draft saved in Slack", () => {
  const SLACK = "https://app.slack.com/client/T0000000000/D0MADEUP11"
  const LINEAR = "https://linear.app/acme/issue/MADEDUNE-1/x"
  const drafted = (over: Partial<InboxItem> = {}) =>
    item({
      answer: { at: "x", choice: "draft" },
      kind: "draft",
      preview: { link: SLACK, text: "hi", to: "Merritt DM" },
      status: "drafted",
      ...over,
    } as Partial<InboxItem> & Pick<InboxItem, "kind">)

  test("is offered on a Slack draft alone, as the API decides it", () => {
    const previews = [
      { link: SLACK, text: "hi", to: "Merritt DM" },
      { noLink: "a new DM", text: "hi", to: "Merritt DM" },
      { link: LINEAR, text: "hi", to: "MADEDUNE-1" },
    ]
    const shown = previews.map((preview) => canDraft(item({ kind: "draft", preview })))
    expect(shown).toEqual([true, true, false])
    expect(shown).toEqual(previews.map(API_savesDraft))
    expect(canDraft(item({ kind: "decision" }))).toBe(false)
    expect(canDraft(item({ kind: "update" }))).toBe(false)
    expect(canDraft(drafted())).toBe(false)
  })

  test("reads as being saved until its poster acks it, then as done", () => {
    const typed = { at: "x", status: "delivered", via: "session" } as const
    expect(outcomeLine(drafted({ delivery: typed }))).toBe("Saved as a Slack draft")
    expect(itemState(drafted({ delivery: typed }))).toBe("sending")
    expect(outcomeLine(drafted({ answer: { at: "x", choice: "draft", editedText: "hey" } }))).toBe(
      "Saved as a Slack draft with your changes",
    )
    const acked = drafted({
      answer: { ackedAt: "y", at: "x", choice: "draft", link: SLACK },
      delivery: typed,
    })
    expect(itemState(acked)).toBe("done")
    expect(outcomeLine(acked)).toBe("Saved as a Slack draft")
  })

  test("a discarded draft reads Discarded, a word of the card's own", () => {
    expect(
      outcomeLine(drafted({ answer: { at: "x", choice: "discard" }, status: "discarded" })),
    ).toBe("Discarded")
  })

  test("reads as not saved, gray, when Slack refused it and its poster closed it with why", () => {
    const refused = drafted({
      answer: {
        ackedAt: "y",
        at: "x",
        choice: "draft",
        noLink: "Merritt DM already holds a draft",
      },
      delivery: { at: "x", status: "delivered", via: "session" },
    })
    expect(itemState(refused)).toBe("closed")
    expect(inboxLight(refused)).toBe("idle")
    expect(outcomeLine(refused)).toBe("Draft not saved: Merritt DM already holds a draft")
    // a go with no page, such as a budget, still reads as carried out
    const budget = item({
      answer: { ackedAt: "y", at: "x", choice: "approve", noLink: "a budget has no page" },
      kind: "decision",
      status: "approved",
    })
    expect(itemState(budget)).toBe("done")
  })
})

describe("the order the owner sees: an update keeps its place and shows a new-update mark", () => {
  const a = item({ kind: "decision", ref: 1 })
  const b = item({ kind: "decision", ref: 2 })
  const c = item({ kind: "update", ref: 3 })
  const d = item({ kind: "update", ref: 4 })
  const refs = (list: InboxItem[]) => list.map((i) => i.ref)

  test("the first read shows every item in the API's order, holding none", () => {
    const view = pinnedView([c, a, b], null)
    expect(refs(view.rows)).toEqual([3, 1, 2])
    expect(view.held).toEqual([])
  })

  test("an item keeps its place when the API moves it", () => {
    expect(refs(pinnedView([b, c, a], ["id-3", "id-1", "id-2"]).rows)).toEqual([3, 1, 2])
  })

  test("an item that arrived since waits behind the pill, newest first, and pushes nothing", () => {
    const view = pinnedView([d, a, c, b], ["id-1", "id-2"])
    expect(refs(view.rows)).toEqual([1, 2])
    expect(refs(view.held)).toEqual([4, 3])
  })

  test("an item that left the list drops out and the rest keep their order", () => {
    expect(refs(pinnedView([b, c], ["id-3", "id-1", "id-2"]).rows)).toEqual([3, 2])
  })

  test("with nothing left in view, what arrived shows at once, since nothing can move under him", () => {
    const view = pinnedView([c, d], ["id-1"])
    expect(refs(view.rows)).toEqual([4, 3])
    expect(view.held).toEqual([])
  })

  test("the pill counts what waits", () => {
    expect(newLabel(1)).toBe("1 new update")
    expect(newLabel(3)).toBe("3 new updates")
  })
})

describe("movedRows", () => {
  test("names the rows whose place changed or that are new, so their buttons pause", () => {
    // id-1 went to Done: id-2 and id-3 slid up under the cursor
    expect(movedRows(["id-1", "id-2", "id-3"], ["id-2", "id-3"])).toEqual(["id-2", "id-3"])
    // two taken from the pill: they appear on top and every row below slides down
    expect(movedRows(["id-1", "id-2"], ["id-4", "id-3", "id-1", "id-2"])).toEqual([
      "id-4",
      "id-3",
      "id-1",
      "id-2",
    ])
  })

  test("names none when nothing moved, the last row leaving included, or on the first read", () => {
    expect(movedRows(["id-1", "id-2"], ["id-1", "id-2"])).toEqual([])
    expect(movedRows(["id-1", "id-2"], ["id-1"])).toEqual([])
    expect(movedRows(null, ["id-1", "id-2"])).toEqual([])
  })

  test("pauses for 1 second", () => {
    expect(MOVED_PAUSE_MS).toBe(1_000)
  })
})

describe("an item changed after it was posted shows when it was updated", () => {
  const posted = "2026-10-12T10:00:00.000Z"
  const answered = {
    answer: { at: "2026-10-12T10:20:00.000Z", choice: "approve" as const },
    createdAt: posted,
    kind: "decision" as const,
    status: "approved" as const,
    updatedAt: "2026-10-12T10:20:00.000Z",
  }

  test("reads its change time, while one unchanged since it was posted reads none", () => {
    expect(changedAt(item(answered))).toBe("2026-10-12T10:20:00.000Z")
    expect(changedAt(item({ createdAt: posted, kind: "decision", updatedAt: posted }))).toBeNull()
  })

  test("reads an edit 999 ms after its post as unchanged, and one 1000 ms after as changed", () => {
    const after = (ms: number) => new Date(Date.parse(posted) + ms).toISOString()
    const edited = (ms: number) =>
      item({ createdAt: posted, kind: "decision", updatedAt: after(ms) })
    expect(changedAt(edited(999))).toBeNull()
    expect(changedAt(edited(1000))).toBe(after(1000))
  })

  test("reads an update's change time only for its poster's edit, not his read, Dismiss or a resolve", () => {
    const at = "2026-10-12T11:00:00.000Z"
    const update = { createdAt: posted, kind: "update" as const, updatedAt: at }
    // edited, unread or after his read
    expect(changedAt(item(update))).toBe(at)
    expect(changedAt(item({ ...update, readAt: "2026-10-12T10:30:00.000Z" }))).toBe(at)
    // his read stamps both times at once
    expect(changedAt(item({ ...update, readAt: at }))).toBeNull()
    expect(changedAt(item({ ...update, answer: { dismissedAt: at }, readAt: at }))).toBeNull()
    expect(
      changedAt(
        item({
          ...update,
          answer: { at, by: "builder", choice: "resolved" },
          readAt: "2026-10-12T10:30:00.000Z",
        }),
      ),
    ).toBeNull()
  })

  test("reads Updated when it changed after the last look and before this one began", () => {
    const changed = item(answered)
    expect(updatedSince(changed, "2026-10-12T10:10:00.000Z", "2026-10-12T10:30:00.000Z")).toBe(true)
    // seen at the last look
    expect(updatedSince(changed, "2026-10-12T10:20:00.000Z", "2026-10-12T10:30:00.000Z")).toBe(
      false,
    )
    // changed as he looks: it shows in place, not as Updated
    expect(updatedSince(changed, "2026-10-12T10:10:00.000Z", "2026-10-12T10:15:00.000Z")).toBe(
      false,
    )
    // before any look, every change is new
    expect(updatedSince(changed, null, "2026-10-12T10:30:00.000Z")).toBe(true)
    expect(
      updatedSince(item({ createdAt: posted, kind: "decision", updatedAt: posted }), null, posted),
    ).toBe(false)
  })
})

describe("itemState", () => {
  const go = (fields: Partial<InboxItem>) =>
    item({
      answer: { at: "2026-10-12T10:20:00.000Z", choice: "approve" },
      kind: "decision",
      status: "approved",
      ...fields,
    } as Partial<InboxItem> & Pick<InboxItem, "kind">)

  test("open while it needs him, an unread update included", () => {
    expect(itemState(item({ kind: "decision" }))).toBe("open")
    expect(itemState(item({ kind: "update" }))).toBe("open")
  })

  test("a go is sending until its poster closes it, then done", () => {
    expect(itemState(go({ delivery: { status: "pending" } }))).toBe("sending")
    expect(
      itemState(
        go({
          answer: {
            at: "2026-10-12T10:20:00.000Z",
            choice: "approve",
            link: "https://github.com/acme/archive/pull/270",
          },
          delivery: { at: "2026-10-12T10:20:01.000Z", status: "delivered", via: "session" },
        }),
      ),
    ).toBe("done")
  })

  test("failed when the answer did not reach its poster", () => {
    expect(
      itemState(go({ delivery: { code: "NOT_FOUND", reason: "gone", status: "failed" } })),
    ).toBe("failed")
  })

  test("a failure he dismissed asks nothing of him and is being carried out by no one, so it reads closed, and done once its poster closes it anyway", () => {
    const failed = { code: "NOT_FOUND", reason: "gone", status: "failed" } as const
    const dismissed = {
      at: "2026-10-12T10:20:00.000Z",
      choice: "approve",
      dismissedAt: "2026-10-12T10:25:00.000Z",
    } as const
    expect(itemState(go({ answer: dismissed, delivery: failed }))).toBe("closed")
    expect(
      itemState(
        go({
          answer: { ...dismissed, link: "https://github.com/acme/archive/pull/270" },
          delivery: failed,
        }),
      ),
    ).toBe("done")
  })

  test("closed once denied, discarded, settled by its poster, or an update read", () => {
    expect(
      itemState(
        go({ answer: { at: "2026-10-12T10:20:00.000Z", choice: "deny" }, status: "denied" }),
      ),
    ).toBe("closed")
    expect(
      itemState(
        go({
          answer: { at: "2026-10-12T10:20:00.000Z", by: "ops", choice: "settled" },
          status: "done",
        } as Partial<InboxItem>),
      ),
    ).toBe("closed")
    expect(itemState(item({ kind: "update", readAt: "2026-10-12T11:00:00.000Z" }))).toBe("closed")
  })
})

describe("inboxLight: the Inbox takes status colours as the sidebar does", () => {
  const answered = (fields: Partial<InboxItem>) =>
    item({
      answer: { at: "2026-10-12T10:20:00.000Z", choice: "approve" },
      kind: "decision",
      status: "approved",
      ...fields,
    } as Partial<InboxItem> & Pick<InboxItem, "kind">)

  test("draws the sidebar's light for the state that means the same", () => {
    expect(inboxLight(item({ kind: "decision" }))).toBe("waiting")
    expect(inboxLight(item({ kind: "draft" }))).toBe("waiting")
    expect(inboxLight(answered({ delivery: { status: "pending" } }))).toBe("working")
    expect(
      inboxLight(
        answered({
          answer: {
            at: "2026-10-12T10:20:00.000Z",
            choice: "approve",
            link: "https://github.com/acme/archive/pull/270",
          },
        }),
      ),
    ).toBe("done")
    expect(
      inboxLight(answered({ delivery: { code: "NOT_FOUND", reason: "gone", status: "failed" } })),
    ).toBe("failing")
    expect(
      inboxLight(answered({ answer: { at: "2026-10-12T10:20:00.000Z", choice: "deny" } })),
    ).toBe("idle")
    expect(inboxLight(item({ kind: "update", readAt: "2026-10-12T11:00:00.000Z" }))).toBe("idle")
  })

  test("an unread update keeps its dot rather than a light", () => {
    expect(inboxLight(item({ kind: "update" }))).toBeNull()
  })

  test("reads its icon and colour from the sidebar's own table: the orange eye, the blue spinner, the green check, the red error, the gray circle", () => {
    const spec = (light: ReturnType<typeof inboxLight>) => {
      const { Icon, spins, tone } = statusIcon(light!)
      return { Icon: Icon as unknown, spins, tone }
    }
    expect(spec("waiting")).toEqual({ Icon: RiSearchEyeLine, spins: false, tone: "caution" })
    expect(spec("working")).toEqual({ Icon: RiLoader4Line, spins: true, tone: "info" })
    expect(spec("done")).toEqual({ Icon: RiCheckboxCircleLine, spins: false, tone: "success" })
    expect(spec("failing")).toEqual({ Icon: RiErrorWarningLine, spins: false, tone: "destructive" })
    expect(spec("idle")).toEqual({
      Icon: RiCheckboxBlankCircleLine,
      spins: false,
      tone: "inactive",
    })
  })
})

describe("movedStep", () => {
  test("a cold load pauses nothing: the rows that arrive with the first read did not move under him", () => {
    const loading = movedStep(null, null)
    expect(loading).toEqual({ before: null, moved: [] })
    expect(movedStep(loading.before, ["id-1", "id-2"])).toEqual({
      before: ["id-1", "id-2"],
      moved: [],
    })
  })

  test("after that, a row whose place changed is named", () => {
    expect(movedStep(["id-1", "id-2"], ["id-2"])).toEqual({ before: ["id-2"], moved: ["id-2"] })
  })
})

describe("a take by the keyboard", () => {
  const pill = { contains: (node: unknown) => node === "pill" || node === "pill's icon" }

  test("hands focus to the first card while the pill holds it, so it never drops to the page", () => {
    expect(focusAfterTake(pill, "pill", "first card")).toBe("first card")
    expect(focusAfterTake(pill, "pill's icon", "first card")).toBe("first card")
  })

  test("moves no focus when the pill does not hold it or is gone", () => {
    expect(focusAfterTake(pill, "a card's Approve", "first card")).toBeNull()
    expect(focusAfterTake(null, "pill", "first card")).toBeNull()
    expect(focusAfterTake(pill, "pill", null)).toBeNull()
  })
})

describe("Schedule (put an ask away until a time, then it asks again)", () => {
  const sleeping = item({
    answer: { snoozedUntil: "2026-10-08T12:00:00.000Z" } as never,
    kind: "decision",
  })
  const failedSend = item({
    answer: { at: "2026-10-09T06:00:00.000Z", choice: "send" },
    delivery: { code: "SESSIONS_FAILED", reason: "no answer from cmux", status: "failed" },
    kind: "draft",
    ref: 76,
    status: "sent",
  })

  test("an open decision or draft with no answer yet is schedulable", () => {
    expect(schedulable(item({ kind: "decision" }))).toBe(true)
    expect(schedulable(item({ kind: "draft" }))).toBe(true)
  })

  test("an answered, failed or dismissed one is not: its answer, or Retry, is already given", () => {
    expect(
      schedulable(
        item({ answer: { at: "x", choice: "approve" }, kind: "decision", status: "approved" }),
      ),
    ).toBe(false)
    expect(schedulable(failedSend)).toBe(false)
  })

  test("a chat reply its poster is not done with is, since he can open its card again and put it away; one its poster closed is not", () => {
    expect(schedulable(item({ answer: { at: "x", choice: "replied" }, kind: "decision" }))).toBe(
      true,
    )
    expect(
      schedulable(item({ answer: { ackedAt: "y", at: "x", choice: "replied" }, kind: "draft" })),
    ).toBe(false)
  })

  test("an update is never, and one still sleeping is, so it can be put away again", () => {
    expect(schedulable(item({ kind: "update" }))).toBe(false)
    expect(schedulable(sleeping)).toBe(true)
  })

  test("a sleeping item in a stale read asks nothing in its outcome line, its actions still on the card", () => {
    expect(outcomeLine(sleeping)).toBeNull()
    expect(needsYou(sleeping)).toBe(true)
  })

  test("another zone moves Schedule's fixed times to its wall clock, its daylight saving change included", () => {
    // 10:00Z on Sunday the 18th is 11:00 in Lisbon (UTC+1), whose clocks go back to UTC on the 25th
    expect(
      scheduleChoices(new Date("2026-10-18T10:00:00.000Z"), "Europe/Lisbon").map(
        ({ at, label, when }) => [label, at, when],
      ),
    ).toEqual([
      ["In 30 minutes", "2026-10-18T10:30:00.000Z", "Sun 18 Oct, 11:30"],
      ["In 1 hour", "2026-10-18T11:00:00.000Z", "Sun 18 Oct, 12:00"],
      ["In 3 hours", "2026-10-18T13:00:00.000Z", "Sun 18 Oct, 14:00"],
      ["This evening 18:00", "2026-10-18T17:00:00.000Z", "Sun 18 Oct, 18:00"],
      ["Tomorrow 09:00", "2026-10-19T08:00:00.000Z", "Mon 19 Oct, 09:00"],
      ["Next Sun 09:00", "2026-10-25T09:00:00.000Z", "Sun 25 Oct, 09:00"],
    ])
  })

  test("Schedule's fixed times, in the owner's zone, each naming its day, soonest first, with none past and none twice", () => {
    const at = (now: string) =>
      scheduleChoices(new Date(now), "Asia/Kolkata").map(({ at, label, when }) => [label, at, when])
    // 10:00Z on Saturday the 17th is 15:30 IST, so this evening's 18:00 is still ahead
    expect(at("2026-10-17T10:00:00.000Z")).toEqual([
      ["In 30 minutes", "2026-10-17T10:30:00.000Z", "Sat 17 Oct, 16:00"],
      ["In 1 hour", "2026-10-17T11:00:00.000Z", "Sat 17 Oct, 16:30"],
      ["This evening 18:00", "2026-10-17T12:30:00.000Z", "Sat 17 Oct, 18:00"],
      ["In 3 hours", "2026-10-17T13:00:00.000Z", "Sat 17 Oct, 18:30"],
      ["Tomorrow 09:00", "2026-10-18T03:30:00.000Z", "Sun 18 Oct, 09:00"],
      ["Monday 09:00", "2026-10-19T03:30:00.000Z", "Mon 19 Oct, 09:00"],
      ["Next Sat 09:00", "2026-10-24T03:30:00.000Z", "Sat 24 Oct, 09:00"],
    ])
    // 14:00Z is 19:30 IST: this evening's 18:00 has passed, so it is left out
    expect(at("2026-10-17T14:00:00.000Z").map(([label]) => label)).toEqual([
      "In 30 minutes",
      "In 1 hour",
      "In 3 hours",
      "Tomorrow 09:00",
      "Monday 09:00",
      "Next Sat 09:00",
    ])
    // 02:00Z on Sunday is 07:30 IST, before its 09:00, so the morning choice is today's
    expect(at("2026-10-18T02:00:00.000Z").map(([label, iso]) => `${label} ${iso}`)).toEqual([
      "In 30 minutes 2026-10-18T02:30:00.000Z",
      "In 1 hour 2026-10-18T03:00:00.000Z",
      "Today 09:00 2026-10-18T03:30:00.000Z",
      "In 3 hours 2026-10-18T05:00:00.000Z",
      "This evening 18:00 2026-10-18T12:30:00.000Z",
      "Monday 09:00 2026-10-19T03:30:00.000Z",
      "Next Sun 09:00 2026-10-25T03:30:00.000Z",
    ])
    // 06:00Z on Sunday is 11:30 IST: tomorrow's 09:00 is Monday's, so Monday 09:00 is left out as the same moment
    expect(at("2026-10-18T06:00:00.000Z").map(([label]) => label)).toEqual([
      "In 30 minutes",
      "In 1 hour",
      "In 3 hours",
      "This evening 18:00",
      "Tomorrow 09:00",
      "Next Sun 09:00",
    ])
    // 09:30Z is 15:00 IST: in 3 hours is this evening's 18:00, which keeps its name
    expect(at("2026-10-17T09:30:00.000Z").map(([label]) => label)).toEqual([
      "In 30 minutes",
      "In 1 hour",
      "This evening 18:00",
      "Tomorrow 09:00",
      "Monday 09:00",
      "Next Sat 09:00",
    ])
    // 20:30Z on Sunday is 02:00 IST on Monday: Today 09:00 is this Monday's, so the coming Monday is a week out, the same moment as Next Mon, which keeps that name
    expect(at("2026-10-18T20:30:00.000Z").map(([label, iso]) => `${label} ${iso}`)).toEqual([
      "In 30 minutes 2026-10-18T21:00:00.000Z",
      "In 1 hour 2026-10-18T21:30:00.000Z",
      "In 3 hours 2026-10-18T23:30:00.000Z",
      "Today 09:00 2026-10-19T03:30:00.000Z",
      "This evening 18:00 2026-10-19T12:30:00.000Z",
      "Next Mon 09:00 2026-10-26T03:30:00.000Z",
    ])
    // now with seconds: "In 30 minutes" from 08:30:00.4 IST and "In 3 hours" from 15:00:00.25 IST show the same minute as a named time, which keeps it
    expect(at("2026-10-18T03:00:00.400Z").map(([label]) => label)).toEqual([
      "Today 09:00",
      "In 1 hour",
      "In 3 hours",
      "This evening 18:00",
      "Monday 09:00",
      "Next Sun 09:00",
    ])
    expect(at("2026-10-17T09:30:00.250Z").map(([label]) => label)).toEqual([
      "In 30 minutes",
      "In 1 hour",
      "This evening 18:00",
      "Tomorrow 09:00",
      "Monday 09:00",
      "Next Sat 09:00",
    ])
  })
})

describe("Pick a time's moment", () => {
  // local times throughout, since the Calendar's day and the time field are in this browser's time zone
  const now = new Date(2026, 9, 18, 14, 30)
  const today = new Date(2026, 9, 18)

  test("a day and a time name that moment on that day", () => {
    expect(pickedAt(new Date(2026, 9, 20), "09:00", now)).toEqual(new Date(2026, 9, 20, 9, 0))
  })

  test("today names a time still ahead, and nothing at or before now", () => {
    expect(pickedAt(today, "15:00", now)).toEqual(new Date(2026, 9, 18, 15, 0))
    expect(pickedAt(today, "14:30", now)).toBeNull()
    expect(pickedAt(today, "09:00", now)).toBeNull()
  })

  test("a past day, no day, or a time the field left empty, half typed or out of range names nothing, so Set stays off", () => {
    expect(pickedAt(new Date(2026, 9, 17), "23:59", now)).toBeNull()
    expect(pickedAt(undefined, "09:00", now)).toBeNull()
    expect(pickedAt(new Date(2026, 9, 20), "", now)).toBeNull()
    expect(pickedAt(new Date(2026, 9, 20), "9:", now)).toBeNull()
    expect(pickedAt(new Date(2026, 9, 20), "24:00", now)).toBeNull()
    expect(pickedAt(new Date(2026, 9, 20), "09:60", now)).toBeNull()
  })
})

describe("a decision's Send before a pick", () => {
  test("says to pick an option while none is picked, and nothing once one is", () => {
    expect(sendWhy(null)).toBe("Pick an option first")
    expect(sendWhy({ go: false, index: 1, label: "Deny", letter: "B" })).toBeNull()
  })
})

// A decision's options (#873): a yes or no keeps Approve and Deny, real alternatives letter A to E with None of these, and the result line names the pick
describe("a decision's options", () => {
  const OPTIONS = [
    { description: "Staging first, a day of soak", label: "Port to staging, then main" },
    { label: "Hotfix main" },
    { label: "Wait for the next ship" },
  ]
  const ask = (preview: object, answer: object | null = null) =>
    item({
      answer,
      kind: "decision",
      preview: { text: "Which way?", type: "ask", ...preview },
      status: answer ? "approved" : "open",
    } as never)

  test("a lettered ask's rows run A to E, then None of these, or its own deny", () => {
    const choices = decisionChoices(ask({ options: OPTIONS }))
    expect(choices?.shape).toBe("letters")
    expect(choices?.rows.map((row) => [row.letter, row.label, row.go])).toEqual([
      ["A", "Port to staging, then main", true],
      ["B", "Hotfix main", true],
      ["C", "Wait for the next ship", true],
      ["D", "None of these", false],
    ])
    expect(choices?.rows[0]?.description).toBe("Staging first, a day of soak")
    expect(decisionChoices(ask({ deny: "Drop it", options: OPTIONS }))?.rows.at(-1)?.label).toBe(
      "Drop it",
    )
  })

  test("a yes or no is Approve and Deny with their labels, a typed decision's from the one map, and a secret has none", () => {
    for (const [preview, labels] of [
      [{ deny: "Keep it on dev", options: [{ label: "Port it" }] }, ["Port it", "Keep it on dev"]],
      [{ approve: "Port it" }, ["Port it", "Deny"]],
      [{}, ["Approve", "Deny"]],
    ] as const) {
      const choices = decisionChoices(ask(preview))
      expect(choices?.shape).toBe("yes-no")
      expect(choices?.rows.map((row) => row.label)).toEqual([...labels])
    }
    expect(decisionChoices(items[0]!)?.rows.map((row) => row.label)).toEqual([
      "Ship 3f9a2c1 to main",
      "Hold the ship",
    ])
    expect(
      decisionChoices(
        item({ kind: "decision", preview: { key: "K", sink: {}, type: "secret" } } as never),
      ),
    ).toBeNull()
    expect(decisionChoices(items[1]!)).toBeNull()
  })

  test("the result line names the picked option: a letter and label, a side and label, or a bare side, and no verb typed for its poster (#1013)", () => {
    const picked = (preview: object, answer: object) =>
      outcomeLine({
        ...ask(preview, { at: "x", ...answer }),
        delivery: { status: "pending" },
      } as InboxItem)
    expect(picked({ options: OPTIONS }, { choice: "approve", option: 1 })).toBe("B · Hotfix main")
    expect(picked({ options: OPTIONS }, { choice: "deny" })).toBe("D · None of these")
    expect(picked({ deny: "Keep it", options: [{ label: "Port it" }] }, { choice: "deny" })).toBe(
      "Deny · Keep it",
    )
    expect(picked({ options: [{ label: "Port it" }] }, { choice: "approve" })).toBe(
      "Approve · Port it",
    )
    expect(picked({}, { choice: "approve" })).toBe("Approve")
    expect(picked({}, { choice: "deny" })).toBe("Deny")
    expect(picked({ options: [{ label: "Port it" }] }, { choice: "edit" })).toBe(
      "Approve · Port it · With your changes",
    )
  })
})

describe("a card's Cmd/Ctrl+Enter", () => {
  const enter = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "Enter",
    keyCode: 13,
    metaKey: true,
    repeat: false,
    shiftKey: false,
    target: "box" as const,
  }
  const card = {
    choosing: false,
    draftReady: false,
    picked: false,
  }

  test("leaves a labelled ask's pick to the Questionnaire", () => {
    expect(
      cardKey({ ...enter, target: "choice" }, { ...card, choosing: true, picked: true }),
    ).toBeNull()
  })

  test("holds the key on a labelled ask with no side picked, so nothing is sent and no error shows", () => {
    expect(cardKey({ ...enter, target: "choice" }, { ...card, choosing: true })).toBe("hold")
  })

  test("leaves a key pressed on a link or a button to the browser, so Cmd+Enter on Open thread opens it and sends nothing", () => {
    for (const shown of [{ ...card, draftReady: true }, { ...card, choosing: true }, card]) {
      expect(cardKey({ ...enter, target: "elsewhere" }, shown)).toBe("leave")
    }
  })

  test("presses a draft's Send while it would pass, and holds the key on any other card", () => {
    expect(cardKey(enter, { ...card, draftReady: true })).toBe("send")
    expect(cardKey(enter, card)).toBe("hold")
  })

  test("holds a repeat, so a held key sends once", () => {
    expect(cardKey({ ...enter, repeat: true }, { ...card, draftReady: true })).toBe("hold")
  })

  test("ignores Enter alone, Shift, Alt, any other key and a key that composes text", () => {
    for (const key of [
      { ...enter, metaKey: false },
      { ...enter, shiftKey: true },
      { ...enter, altKey: true },
      { ...enter, key: "a" },
      { ...enter, isComposing: true },
      { ...enter, keyCode: 229 },
    ]) {
      expect(cardKey(key, { ...card, draftReady: true })).toBeNull()
    }
  })
})

describe("a card a chat reply collapsed opens again", () => {
  const replied = { at: "2026-10-23T10:00:00.000Z", choice: "replied" as const }

  test("an open decision or draft whose answer is a chat reply its poster is not done with", () => {
    expect(reopenable(item({ answer: replied, kind: "decision" }))).toBe(true)
    expect(reopenable(item({ answer: replied, kind: "draft" }))).toBe(true)
  })

  test("not an open one with no answer, an answered one, a reply its poster closed, or an update", () => {
    expect(reopenable(item({ kind: "draft" }))).toBe(false)
    expect(
      reopenable(item({ answer: { at: "x", choice: "send" }, kind: "draft", status: "sent" })),
    ).toBe(false)
    expect(
      reopenable(
        item({ answer: { ...replied, ackedAt: "2026-10-23T10:05:00.000Z" }, kind: "draft" }),
      ),
    ).toBe(false)
    expect(reopenable(item({ kind: "update" }))).toBe(false)
  })

  const e = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "e",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    target: "elsewhere" as const,
  }

  test("E alone opens or folds it, Caps Lock's included, on the card, a button or a choice", () => {
    expect(reopenKey(e)).toBe(true)
    expect(reopenKey({ ...e, key: "E" })).toBe(true)
    expect(reopenKey({ ...e, target: "choice" })).toBe(true)
  })

  test("never E typed in its box, with a modifier, held down or composing, nor another key", () => {
    expect(reopenKey({ ...e, target: "box" })).toBe(false)
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "isComposing"])
      expect(reopenKey({ ...e, [modifier]: true })).toBe(false)
    expect(reopenKey({ ...e, key: "E", shiftKey: true })).toBe(false)
    expect(reopenKey({ ...e, key: "Enter" })).toBe(false)
  })
})

describe("a card folds by priority, the ones needing an answer staying open", () => {
  const NOW = Date.parse("2026-11-06T10:00:00.000Z")
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const decision = item({ kind: "decision", ref: 1 })
  const draft = item({ kind: "draft", ref: 2 })
  const unread = item({ kind: "update", ref: 3 })
  const read = item({ kind: "update", readAt: ago(60_000), ref: 4 })
  const answered = item({
    answer: { at: ago(60_000), choice: "approve" },
    kind: "decision",
    ref: 5,
    status: "approved",
  })
  const replied = item({ answer: { at: ago(60_000), choice: "replied" }, kind: "draft", ref: 6 })

  test("an open decision or draft and an unread update show open", () => {
    for (const card of [decision, draft, unread]) expect(foldsByDefault(card, NOW)).toBe(false)
  })

  test("a read update and a chat reply waiting on its poster fold in the list, and an answered decision on In progress", () => {
    const view = inboxView([read, answered, replied])
    expect(view.shown).toEqual([read, replied])
    expect(view.progress).toEqual([answered])
    for (const card of [read, answered, replied]) expect(foldsByDefault(card, NOW)).toBe(true)
  })

  test("every card on the In progress, Archive and Done shelves folds", () => {
    const working = item({
      answer: { at: ago(60_000), choice: "approve" },
      kind: "decision",
      ref: 7,
      status: "approved",
    })
    const archived = item({
      answer: { at: ago(60_000), choice: "clear" },
      kind: "decision",
      ref: 8,
      status: "cleared",
    })
    const settled = item({
      answer: { dismissedAt: ago(60_000) },
      kind: "update",
      readAt: ago(60_000),
      ref: 9,
    })
    const view = inboxView([working, archived, settled])
    expect([view.progress, view.archived, view.done]).toEqual([[working], [archived], [settled]])
    for (const card of [working, archived, settled]) expect(foldsByDefault(card, NOW)).toBe(true)
  })

  test("an ask put away with Later folds until its time, then shows open", () => {
    const snoozed = item({
      answer: { snoozedUntil: new Date(NOW + 60_000).toISOString() },
      kind: "decision",
      ref: 10,
    })
    expect(foldsByDefault(snoozed, NOW)).toBe(true)
    expect(foldsByDefault(snoozed, NOW + 60_000)).toBe(false)
  })

  test("a card that rises to an open tier shows open: an answer that failed to send, an update made unread", () => {
    const failed = {
      ...answered,
      delivery: { code: "SESSIONS_FAILED", reason: "no answer from cmux", status: "failed" },
    } as InboxItem
    expect(foldsByDefault(failed, NOW)).toBe(false)
    expect(foldsByDefault({ ...read, readAt: null }, NOW)).toBe(false)
  })
})

// #882's table: each state's verbs, Seen while unread, a folded row keeping them all
describe("a card's verbs on each state (#882)", () => {
  const READ = "2026-10-07T11:00:00.000Z"
  const secret = (over: Partial<InboxItem> = {}) =>
    item({
      kind: "decision",
      preview: {
        key: "API_KEY",
        sink: { environments: ["production"], project: "p", scope: "s", type: "vercel" },
        type: "secret",
      },
      ref: 7,
      ...over,
    } as never)
  const answered = (over: Partial<InboxItem> = {}) =>
    item({
      answer: { at: "x", choice: "approve" },
      kind: "decision",
      readAt: READ,
      ref: 4,
      status: "approved",
      ...over,
    } as never)

  test("a waiting ask, draft or secret takes Later, Archive and Dismiss, and Seen while unread", () => {
    for (const card of [item({ kind: "decision" }), item({ kind: "draft" }), secret()]) {
      expect(verbs(card, "inbox")).toEqual(["seen", "later", "archive", "dismiss"])
      expect(verbs({ ...card, readAt: READ } as InboxItem, "inbox")).toEqual([
        "later",
        "archive",
        "dismiss",
      ])
    }
  })

  test("a waiting one put off until a time keeps the same verbs on Later", () => {
    const snoozed = item({ answer: { snoozedUntil: "2026-11-04T10:00:00.000Z" }, kind: "draft" })
    expect(verbs(snoozed, "snoozed")).toEqual(["seen", "later", "archive", "dismiss"])
  })

  test("an update in the list takes Done, Later, Archive and Dismiss, and Seen while unread", () => {
    expect(verbs(item({ kind: "update" }), "inbox")).toEqual([
      "seen",
      "done",
      "later",
      "archive",
      "dismiss",
    ])
    expect(verbs(item({ kind: "update", readAt: READ }), "inbox")).toEqual([
      "done",
      "later",
      "archive",
      "dismiss",
    ])
  })

  test("an answered, working or failed card takes Done and Dismiss, with no Later or Archive", () => {
    const failed = answered({
      delivery: { code: "LOST", reason: "lost", status: "failed" },
    } as never)
    const denied = answered({ answer: { at: "x", choice: "deny" }, status: "denied" } as never)
    const replied = item({ answer: { at: "x", choice: "replied" }, kind: "decision", readAt: READ })
    for (const card of [answered(), failed, denied, replied]) {
      expect(verbs(card, "inbox")).toEqual(["done", "dismiss"])
      expect(verbs(card, "progress")).toEqual(["done", "dismiss"])
    }
    expect(verbs(answered({ readAt: null }), "inbox")).toEqual(["seen", "done", "dismiss"])
  })

  test("an archived card takes Later, Move back and Dismiss, and one set aside before Archive kept it open Move back and Dismiss", () => {
    const archived = item({ answer: { archivedAt: READ }, kind: "decision" } as never)
    expect(verbs(archived, "archived")).toEqual(["later", "moveBack", "dismiss"])
    const cleared = item({ answer: { at: "x", choice: "clear" }, kind: "draft", status: "cleared" })
    expect(verbs(cleared, "archived")).toEqual(["moveBack", "dismiss"])
  })

  test("an answered card archived from Done takes Move back and Dismiss, with no Later, which it would refuse (PG-1909)", () => {
    const archived = answered({ answer: { archivedAt: READ, at: "x", choice: "deny" } } as never)
    expect(verbs(archived, "archived")).toEqual(["moveBack", "dismiss"])
  })

  test("a card on Done takes Archive and Dismiss until dismissed, one whose send failed Dismiss alone, and one dismissed while it waited Move back (PG-1909)", () => {
    const done = answered({ answer: { at: "x", choice: "approve", dismissedAt: READ } } as never)
    expect(verbs(done, "done")).toEqual(["archive", "dismiss"])
    const doneUpdate = item({
      answer: { dismissedAt: READ },
      kind: "update",
      readAt: READ,
    } as never)
    expect(verbs(doneUpdate, "done")).toEqual(["archive", "dismiss"])
    const failed = answered({
      answer: { at: "x", choice: "approve", dismissedAt: READ },
      delivery: { code: "LOST", reason: "lost", status: "failed" },
    } as never)
    expect(verbs(failed, "done")).toEqual(["dismiss"])
    const dismissed = answered({
      answer: { at: "x", choice: "approve", dismissed: true, dismissedAt: READ },
    } as never)
    expect(verbs(dismissed, "done")).toEqual([])
    const setAside = item({
      answer: { at: "x", choice: "clear", dismissed: true, dismissedAt: READ },
      kind: "decision",
      status: "cleared",
    } as never)
    expect(verbs(setAside, "done")).toEqual(["moveBack"])
  })

  test("an archived card waits on him moving it back, so it no longer needs him", () => {
    const archived = (kind: "decision" | "update") =>
      item({ answer: { archivedAt: READ }, kind } as never)
    expect(needsYou(archived("decision"))).toBe(false)
    expect(needsYou(archived("update"))).toBe(false)
    expect(needsYou(item({ kind: "decision" }))).toBe(true)
  })
})

// PG-649: a Slack send shares its files into the same thread, and its card says so until the go
describe("uploadsOn", () => {
  const THREAD =
    "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
  const FILES = [
    { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png", kind: "image" as const, name: "before.png" },
  ]
  const words = { text: "hi", to: "@Merritt" }
  const cases: [InboxItem, InboxItem["answer"]][] = [
    [item({ kind: "draft", preview: { ...words, attachments: FILES, link: THREAD } }), null],
    [
      item({
        kind: "draft",
        preview: {
          ...words,
          attachments: FILES,
          link: "https://linear.app/acme/issue/MADEDUNE-1/x",
        },
      }),
      null,
    ],
    [item({ kind: "draft", preview: { ...words, attachments: FILES, noLink: "a new DM" } }), null],
    [item({ kind: "draft", preview: { ...words, link: THREAD } }), null],
    [
      item({
        kind: "decision",
        preview: { ...words, attachments: FILES, link: THREAD, type: "slack" },
      }),
      null,
    ],
    [item({ kind: "decision", preview: { attachments: FILES, text: "look", type: "ask" } }), null],
  ]

  test("names Send on a Slack draft and Approve on a slack decision with files, and nothing else", () => {
    expect(cases.map(([open]) => uploadsOn(open))).toEqual([
      "Send",
      null,
      null,
      null,
      "Approve",
      null,
    ])
  })

  test("marks the same items whose go the API shares into Slack", () => {
    for (const [open] of cases) {
      const choice = open.kind === "draft" ? "send" : "approve"
      const answered = { ...open, answer: { at: "x", choice } } as InboxItem
      expect(uploadsOn(open) !== null).toBe(API_filesToUpload(answered) !== null)
    }
  })

  test("reads a Slack link as the API's slackPlace does, a query, a hash and a thread that does not parse included", () => {
    const team = "https://app.slack.com/client/T0000000000"
    for (const link of [
      THREAD,
      `${team}/C0MADEUP01`,
      `${team}/C0MADEUP01/`,
      `${team}/D0MADEUP11?cdn_fallback=1#top`,
      `${THREAD}?x=1`,
      `${team}/C0MADEUP01/thread/C0MADEUP01-notats`,
      `${team}/C0MADEUP01/thread/C0MADE0101-1700000000.000100`,
      `${team}/C0MADEUP01/thread`,
      `${THREAD}/more`,
      `${team}/C0MADEUP01/files/F0MADEUP01`,
      team,
      "https://evil.example/client/T0000000000/C0MADEUP01",
      "http://app.slack.com/client/T0000000000/C0MADEUP01",
      "not a link",
    ])
      expect([link, slackPlaced(link)]).toEqual([link, API_slackPlace(link) !== null])
  })

  test("leaves an answered card unmarked, its result line counting the files shared", () => {
    const [open] = cases[0]!
    const sent = {
      ...open,
      answer: { at: "x", choice: "send", uploaded: 2 },
      delivery: { at: "x", status: "delivered", to: "ops", via: "session" },
      status: "sent",
    } as InboxItem
    expect(uploadsOn(sent)).toBeNull()
    expect(outcomeLine(sent)).toBe("Sent · 2 files shared")
  })
})

// An answer's line reads what the session has: queued while Claude Code holds it, delivered once it went, lost when neither its screen nor its transcript shows it, which offers Retry
describe("an answer queued, delivered or lost", () => {
  const base = items[4]!
  test("each state reads in the answer line", () => {
    const queued = {
      ...base,
      delivery: { at: "x", id: "d1", status: "queued", to: "ops" },
    } as InboxItem
    expect(outcomeLine(queued)).toBe("Approve · Ship 3f9a2c1 to main · Queued for Ops")
    expect(itemState(queued)).toBe("sending")
    const lost = {
      ...base,
      delivery: { code: "LOST", reason: "Retry sends it again.", status: "failed" },
    } as InboxItem
    expect(outcomeLine(lost)).toBe("Approve · Ship 3f9a2c1 to main · Lost: Retry sends it again.")
    expect(retryable(lost)).toBe(true)
  })

  test("an unconfirmed send names no terminal and offers Check it for me, a note naming the item", () => {
    const cut = {
      ...base,
      delivery: { code: "INTERRUPTED", reason: "whatever deliver said", status: "failed" },
    } as InboxItem
    expect(outcomeLine(cut)).toBe(
      "Approve · Ship 3f9a2c1 to main · Send unconfirmed: whether Ops has it is not known",
    )
    expect(sendUnconfirmed(cut)).toBe(true)
    expect(retryable(cut)).toBe(false)
    expect(checkAnswerNote(cut)).toContain(`#i${cut.ref}`)
    expect(checkAnswerNote(cut)).not.toMatch(/\bre #i\d/i)
  })

  // an API restart ends a queued answer's follow-up, so its card offers Retry once it has read queued past the API's bound
  test("a queued answer offers Retry once stuck past the bound, as the API reads it", () => {
    expect(STUCK_QUEUED_MS).toBe(API_STUCK_QUEUED_MS)
    expect(QUEUED_POLL_MS).toBe(API_QUEUED_POLL_MS)
    const at = Date.parse("2026-10-12T06:00:00.000Z")
    const queued = {
      ...base,
      delivery: { at: new Date(at).toISOString(), id: "d1", status: "queued", to: "ops" },
    } as InboxItem
    expect(retryable(queued, at + STUCK_QUEUED_MS - 1)).toBe(false)
    expect(retryable(queued, at + STUCK_QUEUED_MS)).toBe(true)
    expect(API_retryable(queued, new Date(at + STUCK_QUEUED_MS))).toBe(true)
  })
})

// ib-7: a secret ask's comment goes through Reply alone, so a value typed there would reach a transcript.
describe("commentRefused", () => {
  test("refuses a comment equal to the value field, its edges trimmed", () => {
    expect(commentRefused(" sk-made-up-123 ", "sk-made-up-123\n")).toContain("That is the value")
  })

  test("passes any other comment, and any comment while the field is empty", () => {
    expect(commentRefused("Which project is this for?", "sk-made-up-123")).toBeNull()
    expect(commentRefused("sk-made-up-123", "")).toBeNull()
    expect(commentRefused("", "  ")).toBeNull()
  })
})

// no-chat-question's Stop gate restates the list's rule as listedItem, since a hook loads no web code; both decide every item the same (PG-1486)
describe("the Stop gate's listed rule", () => {
  test.each(ITEMS.filter((c) => !c.hidden))("$name: listed as the Inbox lists it", ({ item }) => {
    const full = {
      createdAt: AFTER,
      delivery: null,
      id: "x",
      ref: 1,
      ...item,
    } as unknown as InboxItem
    expect(listedItem(item)).toBe(inboxView([full]).shown.length === 1)
  })
})
