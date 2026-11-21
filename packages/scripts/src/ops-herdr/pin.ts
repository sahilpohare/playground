import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { dataDirOf } from "../../../env/src/data-dir"

export type PinSource = { sha256: Record<string, string>; version: string }

// The PR-owned pin: herdr's version and GitHub's SHA-256 digest of each release asset, keyed by `${platform}-${arch}`. Imports only relative paths, so install.sh runs herdr-pin.ts before `bun install`.
export const PIN_SOURCE = JSON.parse(
  readFileSync(join(import.meta.dir, "pin.json"), "utf8"),
) as PinSource

// The release asset each pin key downloads.
export const ASSET_NAMES: Record<string, string> = {
  "darwin-arm64": "herdr-macos-aarch64",
  "darwin-x64": "herdr-macos-x86_64",
  "linux-arm64": "herdr-linux-aarch64",
  "linux-x64": "herdr-linux-x86_64",
}

export const assetOf = (
  platform: string = process.platform,
  arch: string = process.arch,
): string | null => (`${platform}-${arch}` in ASSET_NAMES ? `${platform}-${arch}` : null)

export const pinnedSum = (asset: string): string => PIN_SOURCE.sha256[asset] ?? ""

// Playground's own copy, run by this full path alone and never put on PATH, so a herdr the human installs or upgrades is never the one the factory runs. It follows HOME alone, as the herdr folder does, so every Claude login and every scratch herdr server runs the one pinned copy.
export const herdrPath = (env: Record<string, string | undefined> = process.env): string =>
  join(dataDirOf({}, env.HOME || homedir()), "bin", "herdr")
