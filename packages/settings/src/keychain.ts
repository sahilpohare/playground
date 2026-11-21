import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// By relative path, as settings.ts imports, since tests outside the package import this file.
import { accountSettings, type Provider } from "./accounts"
import { writeAtomically } from "./folder"
import { modelSettings } from "./models"
import type { Settings } from "./settings"

// The one writer of an account's secret: a Claude token under usage.keychainService by its email, a GLM key under models.glmKeychainService by its label; `security` comes from PATH, so a test puts a fake first.
export const keychainServiceOf = (settings: Settings, provider: Provider): string =>
  provider === "glm"
    ? modelSettings.get(settings, "models.glmKeychainService")
    : accountSettings.get(settings, "usage.keychainService")

// The characters a token, a key, an email and a label hold, so each sits in one double-quoted word of security's command line.
const SECRET = /^[A-Za-z0-9._~+/=-]+$/
const KEY = /^[A-Za-z0-9._+@-]+$/

const security = (args: string[], input?: string) =>
  spawnSync("security", args, { encoding: "utf8", input, stdio: ["pipe", "ignore", "pipe"] })

// Where a stack that does not read this machine keeps its secrets instead of the Keychain: a record file of each one's sha256 by provider and key, so a fixture stack never reaches the real Keychain.
export type Keychain = { record?: string }

const readRecord = (path: string): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

const writeRecord = (path: string, record: Record<string, string>) =>
  writeAtomically(path, `${JSON.stringify(record, null, 2)}\n`)

// Saves the secret, replacing one kept before: it goes to `security -i` on stdin, so no argv ever holds it.
export const storeSecret = (
  settings: Settings,
  provider: Provider,
  key: string,
  secret: string,
  keychain: Keychain = {},
): void => {
  if (!KEY.test(key)) throw new Error(`${key} is not an email or a label`)
  if (!SECRET.test(secret))
    throw new Error("the secret holds a character no token or key holds, so it is not saved")
  if (keychain.record) {
    const record = readRecord(keychain.record)
    record[`${provider}:${key}`] = createHash("sha256").update(secret).digest("hex")
    return writeRecord(keychain.record, record)
  }
  const service = keychainServiceOf(settings, provider)
  const run = security(
    ["-i"],
    `add-generic-password -U -s "${service}" -a "${key}" -w "${secret}"\n`,
  )
  // a failed command shows in its exit or its error output, whichever security -i gives
  if (run.status !== 0 || run.error || run.stderr.trim())
    throw new Error(`the secret store refused the ${service} item for ${key}`)
}

// Whether the item was there to remove.
export const removeSecret = (
  settings: Settings,
  provider: Provider,
  key: string,
  keychain: Keychain = {},
): boolean => {
  if (keychain.record) {
    const record = readRecord(keychain.record)
    if (!(`${provider}:${key}` in record)) return false
    delete record[`${provider}:${key}`]
    writeRecord(keychain.record, record)
    return true
  }
  return (
    security(["delete-generic-password", "-s", keychainServiceOf(settings, provider), "-a", key])
      .status === 0
  )
}

// Whether the item exists, read from its attributes alone, never its secret.
export const hasSecret = (
  settings: Settings,
  provider: Provider,
  key: string,
  keychain: Keychain = {},
): boolean =>
  keychain.record
    ? `${provider}:${key}` in readRecord(keychain.record)
    : security(["find-generic-password", "-s", keychainServiceOf(settings, provider), "-a", key])
        .status === 0
