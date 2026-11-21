import { userInfo } from "node:os"

import { keychainItem, type KeychainItem, type Run } from "../keychain"
import { KEYCHAIN_ITEMS } from "../keychain-items"

// The Mac's Yard token in the macOS Keychain: the local API and `playground yard` read it, so the token stays on this Mac and never reaches a browser.

export const KEYCHAIN_SERVICE = KEYCHAIN_ITEMS.yard.service

export type { Run }

// The item an earlier build kept the relay token in, apart from the Yard token; a read moves its token into the one item.
const OLD_RELAY_SERVICE = "playground-yard-relay"

// The item a swap keeps its new token in from before its call until the token is saved (rotate.ts), so a lost answer or a failed save leaves the Mac a token that works.
export const PENDING_SERVICE = "playground-yard-pending"

// A swap's pending token, read only in a Yard token's shape.
export const pendingKeychain = (run?: Run, account = userInfo().username): KeychainItem => {
  const item = keychainItem(PENDING_SERVICE, { account, run })
  return {
    ...item,
    read: async () => {
      const value = await item.read()
      return value && KEYCHAIN_ITEMS.yard.valid.test(value) ? value : null
    },
  }
}

// The one Yard token: a read first moves a token from the old relay item into this one, over whatever it held, and deletes the old item, keeping it when the Keychain refuses the move; a write deletes the old item and a swap's pending one after it, so a later read never moves an old token over a new one and no swap keeps a pending one over it; a remove deletes all three, so a logout stays signed out.
export const keychain = (run?: Run, account = userInfo().username): KeychainItem => {
  const item = keychainItem("yard", { account, run })
  const old = keychainItem(OLD_RELAY_SERVICE, { account, run })
  const pending = keychainItem(PENDING_SERVICE, { account, run })
  return {
    ...item,
    read: async () => {
      const moved = await old.read()
      if (!moved || !KEYCHAIN_ITEMS.yard.valid.test(moved)) return item.read()
      try {
        await item.write(moved)
        await old.remove()
      } catch {
        // the Keychain refused the move: the old item stays, and its token still reads
      }
      return moved
    },
    remove: async () => {
      await item.remove()
      await old.remove()
      await pending.remove()
    },
    write: async (value) => {
      await item.write(value)
      await old.remove()
      await pending.remove()
    },
  }
}

// A bot's token, which `playground yard bot add` writes and never prints, in an item of its own a reveal card names for the owner's Copy.
export const botService = (name: string) => `playground-yard-bot-${name}`

export const botKeychain = (name: string, run?: Run, account = userInfo().username): KeychainItem =>
  keychainItem(botService(name), { account, run })

export type Keychain = KeychainItem
