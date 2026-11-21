import { describe, expect, test } from "bun:test"

import {
  groupOpen,
  groupOrder,
  groupsState,
  moveGroup,
  ORDERED_GROUPS,
  orderState,
  parseGroups,
} from "../../../../../web/next/src/lib/sidebar-groups"

// A browser's localStorage, kept across a reload: a new page reads what the last one wrote.
const storage = () => {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

type Store = ReturnType<typeof storage>

// A new page's state over the same storage, as a reload makes one.
const afterReload = (store: Store) => parseGroups(groupsState(() => store).read())

const refused = () => {
  throw new Error("QuotaExceededError: the quota has been exceeded")
}

describe("the sidebar's groups, open or closed", () => {
  test("a group you close is still closed after a reload, and the others keep their defaults", () => {
    const store = storage()
    groupsState(() => store).set("Orchestrators", false)
    const stored = afterReload(store)
    expect(groupOpen(stored, "Orchestrators", true)).toBe(false)
    expect(groupOpen(stored, "Subagents", true)).toBe(true)
    expect(groupOpen(stored, "Scripts", false)).toBe(false)
  })

  test("a group you open stays open, and each write keeps the other groups' states", () => {
    const store = storage()
    const tab = groupsState(() => store)
    tab.set("Scripts", true)
    tab.set("Channels", false)
    const stored = afterReload(store)
    expect(groupOpen(stored, "Scripts", false)).toBe(true)
    expect(groupOpen(stored, "Channels", true)).toBe(false)
  })

  // The tab reads its own state alone after the first read, so no store, however it fails, leaves a toggle dead or the page down; each case makes the getter a page reaches localStorage through.
  test.each([
    [
      "working",
      () => {
        const store = storage()
        return () => store
      },
    ],
    ["throwing (site data blocked)", () => () => ({ getItem: refused, setItem: refused })],
    ["unreachable", () => refused],
    [
      "refusing writes (full)",
      () => () => ({ getItem: () => '{"Orchestrators":true}', setItem: refused }),
    ],
  ] as const)("a toggle over %s storage shows at once, both ways", (_, make) => {
    const tab = groupsState(make())
    tab.set("Orchestrators", false)
    expect(groupOpen(parseGroups(tab.read()), "Orchestrators", true)).toBe(false)
    tab.set("Orchestrators", true)
    expect(groupOpen(parseGroups(tab.read()), "Orchestrators", false)).toBe(true)
  })

  test("a missing or malformed value reads as no stored state", () => {
    expect(parseGroups(null)).toEqual({})
    expect(parseGroups("not json")).toEqual({})
    expect(parseGroups("[true]")).toEqual({})
    expect(parseGroups('{"Threads":"no","Other":true}')).toEqual({ Other: true })
  })
})

describe("the sidebar's groups, in the order you dragged them into", () => {
  // A new page's order over the same storage, as a reload makes one.
  const orderAfterReload = (store: Store, account = "octocat") =>
    groupOrder(orderState(() => store, account).read())

  test("with nothing saved, the groups keep the default order", () => {
    expect(groupOrder(null)).toEqual([...ORDERED_GROUPS])
    expect(groupOrder("not json")).toEqual([...ORDERED_GROUPS])
    expect(groupOrder('{"Scripts":1}')).toEqual([...ORDERED_GROUPS])
  })

  test("a group moved to the bottom stays there after a reload", () => {
    const store = storage()
    const order = groupOrder(null)
    const moved = moveGroup(order, order, order.indexOf("Channels"), order.length - 1)
    orderState(() => store, "octocat").set(moved)
    expect(orderAfterReload(store)).toEqual([
      "Direct messages",
      "Orchestrators",
      "AI Runners",
      "Subagents",
      "Scripts",
      "Other",
      "Channels",
    ])
  })

  test("a group the saved order does not name, such as a new one, lands at the end", () => {
    expect(groupOrder(JSON.stringify(["Scripts", "Orchestrators"]))).toEqual([
      "Scripts",
      "Orchestrators",
      "Channels",
      "Direct messages",
      "AI Runners",
      "Subagents",
      "Other",
    ])
  })

  // #2429: AI Runners moved up the default order, and an order you saved by dragging keeps its place for every group it names, so one that leaves AI Runners out takes it after them
  test("AI Runners sits right under Orchestrators by default, and after the groups an order you saved names", () => {
    expect(groupOrder(null).indexOf("AI Runners")).toBe(
      groupOrder(null).indexOf("Orchestrators") + 1,
    )
    expect(groupOrder(JSON.stringify(["Orchestrators", "Subagents", "Scripts"]))).toEqual([
      "Orchestrators",
      "Subagents",
      "Scripts",
      "Channels",
      "Direct messages",
      "AI Runners",
      "Other",
    ])
  })

  test("a group the sidebar no longer has drops out, and a repeated one counts once", () => {
    expect(
      groupOrder(JSON.stringify(["Dispatchers", "Scripts", "Gone", "Scripts", 3, "Channels"])),
    ).toEqual([
      "Scripts",
      "Channels",
      "Direct messages",
      "Orchestrators",
      "AI Runners",
      "Subagents",
      "Other",
    ])
  })

  test("a move counts only the groups showing, and a hidden group keeps its place", () => {
    const order = groupOrder(null)
    // Channels, Direct messages and Other show no rows, so the sidebar draws the other four
    const shown = order.filter((group) => !["Channels", "Direct messages", "Other"].includes(group))
    // Move up on Orchestrators, the first shown, has nowhere to go, and on AI Runners passes Orchestrators alone
    expect(moveGroup(order, shown, 1, 0)).toEqual([
      "Channels",
      "Direct messages",
      "AI Runners",
      "Orchestrators",
      "Subagents",
      "Scripts",
      "Other",
    ])
    expect(moveGroup(order, shown, 0, shown.length - 1)).toEqual([
      "Channels",
      "Direct messages",
      "AI Runners",
      "Subagents",
      "Scripts",
      "Orchestrators",
      "Other",
    ])
  })

  test("each signed-in account keeps its own order", () => {
    const store = storage()
    const order = groupOrder(null)
    orderState(() => store, "octocat").set(moveGroup(order, order, 0, 1))
    expect(orderAfterReload(store, "octocat").slice(0, 2)).toEqual(["Direct messages", "Channels"])
    expect(orderAfterReload(store, "hubot")).toEqual([...ORDERED_GROUPS])
  })

  test("over storage that refuses writes, the tab still holds the new order", () => {
    const tab = orderState(() => ({ getItem: refused, setItem: refused }), "octocat")
    const order = groupOrder(null)
    tab.set(moveGroup(order, order, 0, 2))
    expect(groupOrder(tab.read()).slice(0, 3)).toEqual([
      "Direct messages",
      "Orchestrators",
      "Channels",
    ])
  })
})
