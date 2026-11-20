import { describe, expect, test } from "bun:test"

import { REPLY_RE } from "../../../../../../api/hono/src/lib/dashboard/inbox"
import {
  BOT_GETS,
  cardsOf,
  REPLY_REFS,
  pathOn,
  RELAY_GETS,
  RELAY_WRITES,
  relayAllowed,
} from "../../../../../../api/hono/src/lib/relay/protocol"
import { answerKind, RELAY_ANSWER_KINDS } from "../../../../../../packages/message/src/index"

describe("the relay's allowlist", () => {
  test("carries the dashboard's reads, a query included", () => {
    for (const target of [
      "/api/health",
      "/api/v1/board",
      "/api/v1/inbox",
      "/api/v1/workers",
      "/api/v1/workers/abc-123/transcript?before=10",
      "/api/v1/sessions/s1/entries?page=2",
      "/api/v1/settings/clock.ownerZone",
    ])
      expect(relayAllowed("GET", target)).toBe(true)
  })

  test("refuses every first-run and onboarding route, the passwordless sign-in among them", () => {
    for (const target of [
      "/api/v1/onboard/sign-in",
      "/api/v1/onboard/finish",
      "/api/v1/onboard/checks",
      "/api/v1/onboard/fix/x",
    ])
      expect(relayAllowed("GET", target)).toBe(false)
    expect(RELAY_GETS.filter((route) => /onboard|setup|sign-in/.test(route))).toEqual([])
  })

  test("refuses every write, on a read's own path too", () => {
    for (const method of ["DELETE", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
      expect(relayAllowed(method, "/api/v1/workers")).toBe(false)
  })

  test("refuses a path a server might read as another: a dot segment, an encoded slash or a backslash", () => {
    for (const target of [
      "/api/v1/workers/../onboard/sign-in",
      "/api/v1/workers/./transcript",
      "/api/v1/sessions/a%2F..%2Fonboard",
      "/api/v1/sessions/a%5conboard",
      "/api/v1/sessions/a\\b",
      "api/v1/workers",
      "//api/v1/workers",
    ])
      expect(relayAllowed("GET", target)).toBe(false)
  })

  test("refuses a route it does not list, and a listed one with a segment more", () => {
    expect(relayAllowed("GET", "/api/v1/accounts")).toBe(false)
    expect(relayAllowed("GET", "/api/v1/inbox/extra")).toBe(false)
    expect(relayAllowed("GET", "/api/v1/user")).toBe(false)
  })

  test("lists its routes A to Z", () => {
    expect([...RELAY_GETS]).toEqual([...RELAY_GETS].sort())
  })
})

describe("the relay and a secret's routes", () => {
  // a secret moves only between the Keychain and the owner's click on this Mac, so neither secret route rides the relay, whatever its method
  test("carries neither the secret ask's Submit nor a reveal card's Show, and its signed writes name neither", () => {
    for (const route of ["/api/v1/inbox/i1/secret", "/api/v1/inbox/i1/reveal"])
      for (const method of ["GET", "POST"]) expect(relayAllowed(method, route)).toBe(false)
    expect(RELAY_GETS.filter((path) => /secret|reveal/.test(path))).toEqual([])
    for (const route of ["/api/v1/inbox/i1/secret", "/api/v1/inbox/i1/reveal"])
      expect(pathOn(RELAY_WRITES, route)).toBe(false)
    expect(RELAY_WRITES.filter((path) => /secret|reveal/.test(path))).toEqual([])
  })
})

describe("the relay's write list", () => {
  test("lists only the composer's send, an Inbox card's answer, and the Later, Archive and Done its shelves call, A to Z", () => {
    expect([...RELAY_WRITES]).toEqual([
      "/api/v1/inbox/:id/answer",
      "/api/v1/inbox/:id/schedule",
      "/api/v1/inbox/dismiss",
      "/api/v1/messages",
    ])
  })

  test("keeps every first-run, onboarding, sign-in, delete, secret and settings route on the Mac", () => {
    for (const target of [
      "/api/setup/container",
      "/api/v1/onboard/finish",
      "/api/agents/sign-in-as",
      "/api/v1/inbox/abc/secret",
      "/api/v1/remote/approve",
      "/api/v1/remote/revoke",
      "/api/v1/settings/privacy",
      "/api/v1/apps/previews/abc",
    ])
      expect(pathOn(RELAY_WRITES, target)).toBe(false)
  })

  test("shares no route with the reads, which stay GET-only", () => {
    expect(
      RELAY_WRITES.filter((route) => (RELAY_GETS as readonly string[]).includes(route)),
    ).toEqual([])
    for (const route of RELAY_WRITES) expect(relayAllowed("POST", route)).toBe(false)
  })
})

describe("the Inbox cards a relayed answer may reach", () => {
  test("are exactly the kinds whose poster carries out the answer, A to Z", () => {
    expect([...RELAY_ANSWER_KINDS]).toEqual([
      "ask",
      "budget",
      "draft",
      "schema",
      "ship",
      "slack",
      "ticket",
      "update",
    ])
  })

  test("leave every Approve the Mac carries out itself, a delete, a secret ask and a reveal card on the Mac", () => {
    for (const kind of ["accept", "apps", "delete", "grant", "reveal", "secret"])
      expect((RELAY_ANSWER_KINDS as readonly string[]).includes(kind)).toBe(false)
  })

  test("read a card's kind as its decision's preview type, else as a draft or an update", () => {
    expect(answerKind({ kind: "decision", preview: { type: "secret" } })).toBe("secret")
    expect(answerKind({ kind: "draft" })).toBe("draft")
    expect(answerKind({ kind: "update" })).toBe("update")
  })
})

describe("cardsOf, the Inbox cards a relayed write reaches", () => {
  test("reads the card from an answer's or a schedule's path, its query aside, and every id a dismiss lists", () => {
    const id = "0b9c6f1e-1111-4111-8111-000000000001"
    expect(cardsOf({ body: "{}", path: `/api/v1/inbox/${id}/answer?x=1` })).toEqual({ cards: [id] })
    expect(cardsOf({ body: "{}", path: `/api/v1/inbox/${id}/schedule` })).toEqual({ cards: [id] })
    expect(
      cardsOf({
        body: JSON.stringify({ ids: [id, "c2"], tell: true }),
        path: "/api/v1/inbox/dismiss",
      }),
    ).toEqual({ cards: [id, "c2"] })
  })

  test("names no card for a message naming none or a path that only looks like a card's", () => {
    for (const path of [
      "/api/v1/messages",
      "/api/v1/inbox/../answer",
      "/api/v1/inbox/a%2Fb/answer",
      "/api/v1/inbox/abc/answer/more",
      "/api/v1/inbox/abc/schedule/more",
    ])
      expect([path, cardsOf({ body: "{}", path })]).toEqual([path, { cards: [] }])
  })

  test("reads every card a message's text names by its #iN, as the API's REPLY_RE reads one", () => {
    const message = (text: string) => JSON.stringify({ text, to: "dispatcher" })
    expect(
      cardsOf({ body: message("re #i4: done, and RE #i0007 too"), path: "/api/v1/messages" }),
    ).toEqual({ cards: ["#i4", "#i7"] })
    expect(
      cardsOf({ body: message("a #i4 alone, or pre #i5, names none"), path: "/api/v1/messages" }),
    ).toEqual({ cards: [] })
    expect(cardsOf({ body: "not json", path: "/api/v1/messages" })).toEqual({ cards: [] })
    expect(REPLY_REFS.source).toBe(REPLY_RE.source)
  })

  test("reads a dismiss whose body lists no ids as a refusal, which the Mac refuses", () => {
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ ids: [] }),
      JSON.stringify({ ids: [""] }),
    ])
      expect([body, cardsOf({ body, path: "/api/v1/inbox/dismiss" })]).toEqual([
        body,
        { refuse: true },
      ])
  })
})

describe("BOT_GETS, the one route a bot's read takes (#1888)", () => {
  test("is the dispatcher's log alone, on neither RELAY_GETS nor RELAY_WRITES, so the owner's relay never carries it", () => {
    expect(BOT_GETS).toEqual(["/api/v1/dashboard/dispatcher/log"])
    for (const route of BOT_GETS) {
      expect(relayAllowed("GET", route)).toBe(false)
      expect(pathOn(RELAY_WRITES, route)).toBe(false)
    }
  })
})
