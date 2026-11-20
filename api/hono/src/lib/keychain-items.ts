// The Keychain items whose value has a known shape, by name: each one's service and the shape its value takes, which a write and a read check (keychainSpec below adds Playground's other items).
export const KEYCHAIN_ITEMS = {
  slack: {
    invalid: "a Slack user token starts xoxp-",
    service: "playground-slack",
    valid: /^xoxp-[A-Za-z0-9-]+$/,
  },
  // the Mac's one Yard token, relay-on (yard_relay_) or read-only
  yard: {
    invalid: "a Yard token starts yard_",
    service: "playground-yard",
    valid: /^yard_[A-Za-z0-9_-]+$/,
  },
} as const

export type KeychainItemName = keyof typeof KEYCHAIN_ITEMS

export const KEYCHAIN_ITEM_NAMES = Object.keys(KEYCHAIN_ITEMS) as [
  KeychainItemName,
  ...KeychainItemName[],
]

// Playground's own Keychain items by service: a secret ask or a reveal may name any one, so a session asks for a new item with no code change, while its value still moves only on the owner's click; every other service is refused.
export const PLAYGROUND_SERVICE = /^playground-[a-z0-9][a-z0-9-]{0,62}$/

// A value for an item KEYCHAIN_ITEMS does not type: printable ASCII with no quote or backslash, since `security -i` reads it inside double quotes, and no space at either end, since a read trims them.
const ANY_VALUE = /^[!#-[\]-~](?:[ !#-[\]-~]{0,4094}[!#-[\]-~])?$/

export type KeychainSpec = { invalid: string; service: string; valid: RegExp }

// Pure: the item a card names, by a KEYCHAIN_ITEMS name or a playground- service, with its typed entry's value check where it has one, else ANY_VALUE's; null for any other.
export function keychainSpec(item: string): KeychainSpec | null {
  if (Object.hasOwn(KEYCHAIN_ITEMS, item)) return KEYCHAIN_ITEMS[item as KeychainItemName]
  const typed = Object.values(KEYCHAIN_ITEMS).find((entry) => entry.service === item)
  if (typed) return typed
  if (!PLAYGROUND_SERVICE.test(item)) return null
  return {
    invalid: "a value of 1 to 4096 printable characters, with no quote, backslash or line break",
    service: item,
    valid: ANY_VALUE,
  }
}
