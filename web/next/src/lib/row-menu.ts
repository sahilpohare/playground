import type { KeyboardEvent } from "react"

// A manager row's or a group label's menu, its Move up and Move down, opened by a right click, a long press, Shift+F10 or the Menu key.

// Pure: whether a key on a focused row opens its menu.
export const opensMenu = (event: { key: string; shiftKey: boolean }): boolean =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")

// What a manager row's or a group label's description adds, so a screen reader hears the keyboard path.
export const MENU_HINT = "Shift+F10 opens its menu"

// Shift+F10 or the Menu key on a focused manager row or group label opens its menu where the row is, as a right click would, since a browser need not raise a context menu event for them.
export const openMenuByKey = (event: KeyboardEvent<HTMLElement>) => {
  if (!opensMenu(event)) return
  event.preventDefault()
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  )
}
