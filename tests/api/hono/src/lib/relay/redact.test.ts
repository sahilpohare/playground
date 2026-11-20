import { describe, expect, test } from "bun:test"

import {
  envValuesOf,
  keychainValues,
  redact,
} from "../../../../../../api/hono/src/lib/relay/redact"

// Made-up secrets in the shapes a transcript can hold, each built from parts so no scanner reads one as real; none is a real token, key or .env value.
const MADE_UP = {
  anthropic: ["sk-ant-", "madeUpKeyForTheTestOnly0123456789"].join(""),
  github: ["gh", "p_", "madeUpTokenForTheTestOnly0123456789ab"].join(""),
  key: [
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    "bWFkZSB1cCBrZXkgYm9keSBmb3IgdGhlIHRlc3Q=",
    ["-----END ", "PRIVATE KEY-----"].join(""),
  ].join("\n"),
  slack: ["xox", "b-", "madeup-0000-test"].join(""),
  yard: ["ya", "rd_", "madeUpTokenForTheTestOnly0123456"].join(""),
}

// A made-up .env as a live checkout keeps one: a long value, a quoted one, a short one, a comment and an empty one.
const ENV = [
  "# a comment=notAValueAtAll",
  "BETTER_AUTH_SECRET=madeUpSecretValue42",
  'YARD_API_URL="https://yard.example.test"',
  "SHORT=abc1234",
  "EMPTY=",
].join("\n")

describe("redaction of a bot's read on this Mac (#1888)", () => {
  test("reads each .env value of 8 characters or more, its quotes off, and no comment, short or empty one", () => {
    expect(envValuesOf(ENV)).toEqual(["madeUpSecretValue42", "https://yard.example.test"])
  })

  test("a made-up transcript's tokens, private key block and .env value each read [hidden]", () => {
    const transcript = {
      data: {
        entries: [
          { seq: 5, text: `ran with ${MADE_UP.anthropic}` },
          { seq: 6, text: `pushed with ${MADE_UP.github} and ${MADE_UP.slack}` },
          { seq: 7, text: `the key:\n${MADE_UP.key}\nend` },
          { seq: 8, text: "the secret is madeUpSecretValue42 here" },
          { seq: 9, text: "abc1234 is short, so it stays" },
        ],
      },
    }
    const said = redact(JSON.stringify(transcript), envValuesOf(ENV))
    expect(JSON.parse(said).data.entries).toEqual([
      { seq: 5, text: "ran with [hidden]" },
      { seq: 6, text: "pushed with [hidden] and [hidden]" },
      { seq: 7, text: "the key:\n[hidden]\nend" },
      { seq: 8, text: "the secret is [hidden] here" },
      { seq: 9, text: "abc1234 is short, so it stays" },
    ])
    for (const secret of [...Object.values(MADE_UP), "madeUpSecretValue42", "PRIVATE KEY"])
      expect(said).not.toContain(secret)
  })

  test("a body that is not JSON is redacted as text", () => {
    expect(redact(`plain ${MADE_UP.github} and madeUpSecretValue42`, envValuesOf(ENV))).toBe(
      "plain [hidden] and [hidden]",
    )
  })

  test("a JSON key that holds a token or a .env value reads [hidden], as a value does", () => {
    const body = JSON.stringify({
      data: { [`seen ${MADE_UP.yard}`]: 1, madeUpSecretValue42: 2, plain: MADE_UP.github },
    })
    expect(JSON.parse(redact(body, envValuesOf(ENV))).data).toEqual({
      "seen [hidden]": 1,
      "[hidden]": 2,
      plain: "[hidden]",
    })
  })

  test("reads each factory Keychain item and each log reader bot's own, and keeps only the long values it found", async () => {
    const asked: string[] = []
    const kept: Record<string, string> = {
      "playground-yard-bot-scout": "madeUpBotTokenValue",
      slack: "short",
      yard: "madeUpYardTokenValue",
    }
    const read = async (item: string) => {
      asked.push(item)
      if (item === "playground-yard-bot-gone") throw new Error("no such item")
      return kept[item] ?? null
    }
    expect(await keychainValues(["scout[bot]", "gone[bot]"], read)).toEqual([
      "madeUpYardTokenValue",
      "madeUpBotTokenValue",
    ])
    expect(asked).toEqual([
      "slack",
      "yard",
      "playground-yard-bot-scout",
      "playground-yard-bot-gone",
    ])
  })
})
