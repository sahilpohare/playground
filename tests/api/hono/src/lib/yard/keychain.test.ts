import { describe, expect, test } from "bun:test"

import {
  KEYCHAIN_SERVICE,
  keychain,
  PENDING_SERVICE,
  pendingKeychain,
  type Run,
} from "../../../../../../api/hono/src/lib/yard/keychain"

// A made-up relay-on token, in the shape Yard mints one, and the item #2025 kept it in.
const RELAY_TOKEN = `yard_relay_${"0123456789abcdefghijABCDEFGHIJ_-"}`
const OLD_RELAY = "playground-yard-relay"

// A fake `security` over made-up items by service, so no test reaches the real Keychain; refuse makes every write fail.
const fake = (items: Record<string, string>, refuse = false) => {
  const calls: string[][] = []
  const inputs: (string | undefined)[] = []
  const run: Run = async (argv, input) => {
    calls.push(argv)
    inputs.push(input)
    const service = argv[argv.indexOf("-s") + 1] ?? ""
    if (argv[1] === "find-generic-password")
      return service in items
        ? { code: 0, stderr: "", stdout: `${items[service]}\n` }
        : { code: 44, stderr: "", stdout: "" }
    if (argv[1] === "delete-generic-password") {
      const had = service in items
      delete items[service]
      return { code: had ? 0 : 44, stderr: "", stdout: "" }
    }
    if (refuse) return { code: 1, stderr: "security: refused", stdout: "" }
    const [, wrote, value] = input?.match(/-s "([^"]+)" -a "owner" -w "([^"]+)"/) ?? []
    if (wrote && value) items[wrote] = value
    return { code: 0, stderr: "", stdout: "" }
  }
  return { calls, inputs, items, run, store: keychain(run, "owner") }
}

const find = (service: string) => [
  "security",
  "find-generic-password",
  "-s",
  service,
  "-a",
  "owner",
  "-w",
]

describe("the Mac's Yard token in the Keychain", () => {
  test("is read as the signed-in user's generic password under one service", async () => {
    const { calls, store } = fake({ [KEYCHAIN_SERVICE]: "yard_abc" })
    expect(await store.read()).toBe("yard_abc")
    expect(calls).toEqual([find(OLD_RELAY), find(KEYCHAIN_SERVICE)])
  })

  test("reads as none when the item is missing or holds no Yard token", async () => {
    expect(await fake({}).store.read()).toBeNull()
    expect(await fake({ [KEYCHAIN_SERVICE]: "hunter2" }).store.read()).toBeNull()
  })

  test("writes a Yard token in place through stdin, never in an argv, and refuses anything else", async () => {
    const { calls, inputs, store } = fake({})
    await store.write("yard_new-Token_1")
    await store.write(RELAY_TOKEN)
    const del = ["security", "delete-generic-password", "-s", OLD_RELAY, "-a", "owner"]
    const dropPending = [
      "security",
      "delete-generic-password",
      "-s",
      PENDING_SERVICE,
      "-a",
      "owner",
    ]
    expect(calls).toEqual([
      ["security", "-i"],
      del,
      dropPending,
      ["security", "-i"],
      del,
      dropPending,
    ])
    expect(inputs.filter(Boolean)).toEqual([
      `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "owner" -w "yard_new-Token_1"\n`,
      `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "owner" -w "${RELAY_TOKEN}"\n`,
    ])
    await expect(store.write("not a token")).rejects.toThrow("starts yard_")
    await expect(store.write('yard_a" -w "x')).rejects.toThrow("starts yard_")
  })

  test("moves a token kept in the old playground-yard-relay item into the one item on its first read, over a revoked token there, and deletes the old item", async () => {
    const { calls, items, store } = fake({
      [KEYCHAIN_SERVICE]: "yard_revoked",
      [OLD_RELAY]: RELAY_TOKEN,
    })
    expect(await store.read()).toBe(RELAY_TOKEN)
    expect(items).toEqual({ [KEYCHAIN_SERVICE]: RELAY_TOKEN })
    expect(calls).toEqual([
      find(OLD_RELAY),
      ["security", "-i"],
      ["security", "delete-generic-password", "-s", OLD_RELAY, "-a", "owner"],
    ])
    expect(await store.read()).toBe(RELAY_TOKEN)
  })

  test("still reads the old item's token when the Keychain refuses the move, and keeps the old item", async () => {
    const { items, store } = fake({ [OLD_RELAY]: RELAY_TOKEN }, true)
    expect(await store.read()).toBe(RELAY_TOKEN)
    expect(items).toEqual({ [OLD_RELAY]: RELAY_TOKEN })
  })

  test("a write deletes the old item and a pending swap's after it, so the next read keeps the new token and no swap takes the pending one over it", async () => {
    const { items, store } = fake({ [OLD_RELAY]: RELAY_TOKEN, [PENDING_SERVICE]: RELAY_TOKEN })
    await store.write("yard_new-Token_1")
    expect(items).toEqual({ [KEYCHAIN_SERVICE]: "yard_new-Token_1" })
    expect(await store.read()).toBe("yard_new-Token_1")
  })

  test("a logout removes the old item and a pending swap's too, so the next read finds no token and no swap takes one back", async () => {
    const { items, store } = fake({
      [KEYCHAIN_SERVICE]: "yard_abc",
      [OLD_RELAY]: RELAY_TOKEN,
      [PENDING_SERVICE]: RELAY_TOKEN,
    })
    await store.remove()
    expect(items).toEqual({})
    expect(await store.read()).toBeNull()
  })

  test("a swap's pending token sits in an item of its own, read only in a Yard token's shape", async () => {
    const { items, run } = fake({})
    const pending = pendingKeychain(run, "owner")
    await pending.write(RELAY_TOKEN)
    expect(items).toEqual({ [PENDING_SERVICE]: RELAY_TOKEN })
    expect(await pending.read()).toBe(RELAY_TOKEN)
    items[PENDING_SERVICE] = "hunter2"
    expect(await pending.read()).toBeNull()
    await pending.remove()
    expect(items).toEqual({})
  })
})
