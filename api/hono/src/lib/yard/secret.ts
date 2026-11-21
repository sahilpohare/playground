import { randomBytes } from "node:crypto"

// A token's secret: its kind's prefix and 32 random characters, the shape Yard mints and the Mac's swap makes.
export const tokenSecret = (prefix: string): string =>
  `${prefix}${randomBytes(24).toString("base64url")}`

// A relay-on token's shape, yard_relay_ and 32 characters, which no read-only token, yard_ and 32, takes; the hash binds the whole secret, so no caller can make one up.
export const isRelayToken = (value: string): boolean => /^yard_relay_[A-Za-z0-9_-]{32}$/.test(value)

// The prefix of a token's kind, read from its secret alone, as each call reads it (tokenOwner): a relay-on token's, else a read-only one's.
export const tokenPrefix = (value: string): "yard_" | "yard_relay_" =>
  isRelayToken(value) ? "yard_relay_" : "yard_"

// Whether next is a fresh secret of old's kind, in the shape Yard mints one: the one a token's swap takes.
export const sameKind = (old: string, next: string): boolean =>
  next !== old && (isRelayToken(old) ? isRelayToken(next) : /^yard_[A-Za-z0-9_-]{32}$/.test(next))
