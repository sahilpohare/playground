import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { hideSecrets } from "@packages/settings"

import { keychainItem } from "@/lib/keychain"
import { KEYCHAIN_ITEM_NAMES } from "@/lib/keychain-items"
import { botService } from "@/lib/yard/keychain"

// What this Mac hides in a bot's read before it leaves: every secret shape hideSecrets knows, then every value of the live checkout's .env and of the factory's own Keychain items this long or longer, each as [hidden].
export const ENV_VALUE_MIN = 8
const HIDDEN = "[hidden]"

// Pure: each value a .env holds of ENV_VALUE_MIN characters or more, its quotes off, in file order.
export const envValuesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) =>
      line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2"),
    )
    .filter((value) => value.length >= ENV_VALUE_MIN)

// The values of the .env of the checkout this API runs from, which the live dashboard's is on the Mac that holds the relay; none when it has no .env.
export const checkoutEnvValues = (): string[] => {
  try {
    return envValuesOf(readFileSync(resolve(process.cwd(), "../..", ".env"), "utf8"))
  } catch {
    return []
  }
}

// The values of the factory's own Keychain items this Mac knows, read once as the relay starts: each KEYCHAIN_ITEMS item and each yard.logReaders bot's own item, one it cannot read left out.
export const keychainValues = async (
  bots: readonly string[],
  read: (item: string) => Promise<string | null> = async (item) => keychainItem(item).read(),
): Promise<string[]> => {
  const items = [
    ...KEYCHAIN_ITEM_NAMES,
    ...bots.map((login) => botService(login.replace(/\[bot\]$/, ""))),
  ]
  const values = await Promise.all(items.map((item) => read(item).catch(() => null)))
  return values.filter((value): value is string => (value?.length ?? 0) >= ENV_VALUE_MIN)
}

// longest first, so a value inside another is hidden with it
const hideIn = (text: string, values: readonly string[]): string =>
  [...values]
    .sort((a, b) => b.length - a.length)
    .reduce((said, value) => said.replaceAll(value, HIDDEN), hideSecrets(text, HIDDEN))

const hideEach = (value: unknown, values: readonly string[]): unknown =>
  typeof value === "string"
    ? hideIn(value, values)
    : Array.isArray(value)
      ? value.map((item) => hideEach(item, values))
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [hideIn(k, values), hideEach(v, values)]),
          )
        : value

// Pure: a body with every secret hidden: each string of a JSON body, its keys included, as its text reads, so an escaped line break never hides a key block's end, or the body as text when it is not JSON.
export const redact = (body: string, values: readonly string[]): string => {
  try {
    return JSON.stringify(hideEach(JSON.parse(body), values))
  } catch {
    return hideIn(body, values)
  }
}
