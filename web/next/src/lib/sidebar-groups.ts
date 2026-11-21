"use client"

import { useCallback, useSyncExternalStore } from "react"

import type { GroupLabel } from "@/lib/dashboard"

// Every group the sidebar's nav draws, each one's label its toggle.
export type NavGroup =
  | Exclude<GroupLabel, "Dispatchers">
  | "Channels"
  | "Direct messages"
  | "Threads"

// Where this browser keeps each group's open or closed state, so a group you closed is still closed after a reload.
const GROUPS_KEY = "dashboard.sidebar.groups.v1"

export type GroupsOpen = Partial<Record<NavGroup, boolean>>

// Pure: the stored states, keeping only true or false values, and none from a missing or malformed value.
export const parseGroups = (raw: string | null): GroupsOpen => {
  try {
    const value: unknown = JSON.parse(raw ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(([, open]) => typeof open === "boolean"),
    ) as GroupsOpen
  } catch {
    return {}
  }
}

// Pure: whether a group shows open, by its stored state, else its own default.
export const groupOpen = (stored: GroupsOpen, group: NavGroup, initial: boolean): boolean =>
  stored[group] ?? initial

// A tab's group states: read from the store once, on first use, then held in the tab, which every group reads from then on, so a store that throws, refuses a write or is full never leaves a toggle dead or the page down; each toggle writes the whole state through, any error ignored.
export function groupsState(store: () => Pick<Storage, "getItem" | "setItem">) {
  let raw: string | null | undefined
  const read = (): string | null => {
    if (raw === undefined) {
      try {
        raw = store().getItem(GROUPS_KEY)
      } catch {
        raw = null
      }
    }
    return raw
  }
  const set = (group: NavGroup, open: boolean) => {
    raw = JSON.stringify({ ...parseGroups(read()), [group]: open })
    try {
      store().setItem(GROUPS_KEY, raw)
    } catch {
      // the tab keeps the state alone
    }
  }
  return { read, set }
}

const tab = groupsState(() => localStorage)

// Fired on a toggle, so every place that draws the group reads the tab's new state.
const CHANGED = "dashboard-sidebar-groups"

const subscribe = (notify: () => void) => {
  window.addEventListener(CHANGED, notify)
  return () => window.removeEventListener(CHANGED, notify)
}

// A group's open state and its setter, kept in this browser across reloads and shared by every place that draws the group; the server renders its default.
export function useGroupOpen(
  group: NavGroup,
  initial: boolean,
): [boolean, (open: boolean) => void] {
  const raw = useSyncExternalStore(subscribe, tab.read, () => null)
  const setOpen = useCallback(
    (open: boolean) => {
      tab.set(group, open)
      window.dispatchEvent(new Event(CHANGED))
    },
    [group],
  )
  return [groupOpen(parseGroups(raw), group, initial), setOpen]
}

// Every group you can drag into another place, in the order the sidebar draws them until you do; Threads stays first.
export const ORDERED_GROUPS = [
  "Channels",
  "Direct messages",
  "Orchestrators",
  "AI Runners",
  "Subagents",
  "Scripts",
  "Other",
] as const satisfies readonly NavGroup[]

export type OrderedGroup = (typeof ORDERED_GROUPS)[number]

const isOrdered = (group: unknown): group is OrderedGroup =>
  (ORDERED_GROUPS as readonly unknown[]).includes(group)

// Pure: the saved order, each group it names that the sidebar still has, once and as saved, then every group it leaves out, such as a new one, at the end in the default order; a missing or malformed value is the default order.
export const groupOrder = (raw: string | null): OrderedGroup[] => {
  let saved: unknown
  try {
    saved = JSON.parse(raw ?? "[]")
  } catch {
    saved = []
  }
  const kept = [...new Set(Array.isArray(saved) ? saved.filter(isOrdered) : [])]
  return [...kept, ...ORDERED_GROUPS.filter((group) => !kept.includes(group))]
}

// Pure: the whole order after a shown group moves from one place among the shown groups to another; a hidden group, such as Channels with no rows, keeps its own place.
export const moveGroup = (
  order: OrderedGroup[],
  shown: OrderedGroup[],
  from: number,
  to: number,
): OrderedGroup[] => {
  const moved = [...shown]
  moved.splice(to, 0, ...moved.splice(from, 1))
  let next = 0
  return order.map((group) => (shown.includes(group) ? moved[next++] : group))
}

// A tab's group order for one signed-in account, read and written as groupsState reads and writes the open states.
export function orderState(store: () => Pick<Storage, "getItem" | "setItem">, account: string) {
  const key = `dashboard.sidebar.order.v1:${account}`
  let raw: string | null | undefined
  const read = (): string | null => {
    if (raw === undefined) {
      try {
        raw = store().getItem(key)
      } catch {
        raw = null
      }
    }
    return raw
  }
  const set = (order: OrderedGroup[]) => {
    raw = JSON.stringify(order)
    try {
      store().setItem(key, raw)
    } catch {
      // the tab keeps the order alone
    }
  }
  return { read, set }
}

const orders = new Map<string, ReturnType<typeof orderState>>()

// Fired on a move, so the sidebar reads the tab's new order.
const ORDER_CHANGED = "dashboard-sidebar-order"

const subscribeOrder = (notify: () => void) => {
  window.addEventListener(ORDER_CHANGED, notify)
  return () => window.removeEventListener(ORDER_CHANGED, notify)
}

// The signed-in account's group order and its setter, kept in this browser across reloads; the server renders the default order.
export function useGroupOrder(account: string): [OrderedGroup[], (order: OrderedGroup[]) => void] {
  let tab = orders.get(account)
  if (!tab) {
    tab = orderState(() => localStorage, account)
    orders.set(account, tab)
  }
  const raw = useSyncExternalStore(subscribeOrder, tab.read, () => null)
  const setOrder = useCallback(
    (order: OrderedGroup[]) => {
      orders.get(account)?.set(order)
      window.dispatchEvent(new Event(ORDER_CHANGED))
    },
    [account],
  )
  return [groupOrder(raw), setOrder]
}
