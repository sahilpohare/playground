import { describe, expect, test } from "bun:test"

import { keychainItem, type Run } from "../../../../../api/hono/src/lib/keychain"
import {
  KEYCHAIN_ITEMS,
  type KeychainItemName,
  keychainSpec,
} from "../../../../../api/hono/src/lib/keychain-items"

// A made-up relay-on token, in the shape Yard mints one.
const RELAY_TOKEN = `yard_relay_${"0123456789abcdefghijABCDEFGHIJ_-"}`

// A fake `security`, so no test reaches the real Keychain.
const fake = (answer: { code: number; stderr?: string }, name: KeychainItemName = "yard") => {
  const calls: { argv: string[]; input?: string }[] = []
  const run: Run = async (argv, input) => {
    calls.push({ argv, input })
    return { code: answer.code, stderr: answer.stderr ?? "", stdout: "" }
  }
  return { calls, item: keychainItem(name, { account: "owner", run }) }
}

describe("an allowlisted Keychain item", () => {
  test("the allowlist holds slack and yard", () => {
    expect(Object.keys(KEYCHAIN_ITEMS)).toEqual(["slack", "yard"])
  })

  test("yard takes the relay-on token too, so the Mac keeps one Yard token in one item", async () => {
    const { calls, item } = fake({ code: 0 })
    await item.write(RELAY_TOKEN)
    expect(calls).toEqual([
      {
        argv: ["security", "-i"],
        input: `add-generic-password -U -s "playground-yard" -a "owner" -w "${RELAY_TOKEN}"\n`,
      },
    ])
  })

  test("slack takes a Slack user token, xoxp-, under playground-slack, and refuses any other", async () => {
    const { calls, item } = fake({ code: 0 }, "slack")
    for (const value of ["xoxb-made-up", "yard_made-up", "xoxp-a\nb"])
      await expect(item.write(value)).rejects.toThrow("a Slack user token starts xoxp-")
    await item.write("xoxp-made-up-0000")
    expect(calls).toEqual([
      {
        argv: ["security", "-i"],
        input: 'add-generic-password -U -s "playground-slack" -a "owner" -w "xoxp-made-up-0000"\n',
      },
    ])
  })

  test("writes the value on stdin alone, never in an argv", async () => {
    const { calls, item } = fake({ code: 0 })
    await item.write("yard_made-up")
    expect(calls).toEqual([
      {
        argv: ["security", "-i"],
        input: 'add-generic-password -U -s "playground-yard" -a "owner" -w "yard_made-up"\n',
      },
    ])
  })

  test("refuses a value off its shape, or one holding a quote, a backslash or a line break", async () => {
    const { calls, item } = fake({ code: 0 })
    for (const value of ["nope", 'yard_a" -w "x', "yard_a\\b", "yard_a\nb"])
      await expect(item.write(value)).rejects.toThrow("a Yard token starts yard_")
    expect(calls).toEqual([])
  })

  test("names a refusal by its first line, with the value cut out", async () => {
    const { item } = fake({ code: 1, stderr: "security: could not add yard_made-up\nmore" })
    await expect(item.write("yard_made-up")).rejects.toThrow(
      "the secret store refused it: security: could not add …",
    )
  })
})

describe("Playground's other Keychain items, by service (keychainSpec)", () => {
  // a fake `security` for any item, its read answering stdout
  const any = (service: string, stdout = "") => {
    const calls: { argv: string[]; input?: string }[] = []
    const run: Run = async (argv, input) => {
      calls.push({ argv, input })
      return { code: 0, stderr: "", stdout }
    }
    return { calls, item: keychainItem(service, { account: "owner", run }) }
  }

  test("takes any playground- service, and refuses every other, so no card names a browser's or the login keychain's items", () => {
    expect(keychainSpec("playground-glm")?.service).toBe("playground-glm")
    expect(keychainSpec("playground-claude-oauth")?.service).toBe("playground-claude-oauth")
    for (const service of [
      "github.com",
      "Chrome Safe Storage",
      "playground-",
      "Playground-glm",
      "playground-a b",
      "toString",
      "constructor",
    ])
      expect(keychainSpec(service)).toBeNull()
    expect(() => keychainItem("github.com")).toThrow("not a Keychain item Playground may use")
  })

  test("a typed item's service keeps its typed check, by name or by service", () => {
    expect(keychainSpec("playground-slack")).toBe(KEYCHAIN_ITEMS.slack)
    expect(keychainSpec("yard")).toBe(KEYCHAIN_ITEMS.yard)
  })

  test("an untyped item takes printable words with no quote, backslash, line break or space at either end", async () => {
    const { calls, item } = any("playground-glm")
    for (const value of ['a"b', "a\\b", "a\nb", " a", "a ", "", "x".repeat(4097)])
      await expect(item.write(value)).rejects.toThrow("a value of 1 to 4096 printable characters")
    await item.write("made-up key 0000")
    expect(calls).toEqual([
      {
        argv: ["security", "-i"],
        input: 'add-generic-password -U -s "playground-glm" -a "owner" -w "made-up key 0000"\n',
      },
    ])
  })

  test("reads the value off stdout, with no value in any argv", async () => {
    const { calls, item } = any("playground-glm", "made-up-value\n")
    expect(await item.read()).toBe("made-up-value")
    expect(calls).toEqual([
      {
        argv: ["security", "find-generic-password", "-s", "playground-glm", "-a", "owner", "-w"],
        input: undefined,
      },
    ])
  })
})
