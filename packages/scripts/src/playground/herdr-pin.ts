#!/usr/bin/env -S bun --no-env-file
// playground herdr pin: download the pinned herdr's release asset for this machine (macOS or Linux, on arm64 or x64), check its SHA-256, and only then put it at the data folder's bin/herdr; --check reads the copy alone, --asset installs from a file. Imports no workspace package, so install.sh runs it before `bun install`.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"

import { ASSET_NAMES, assetOf, herdrPath, PIN_SOURCE, pinnedSum } from "../ops-herdr/pin"

export type Result = { code: number; line: string }

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const sumAt = (path: string): string | null =>
  existsSync(path) ? sha256(readFileSync(path)) : null

export const releaseUrl = (version: string, asset: string): string =>
  `https://github.com/herdrdev/herdr/releases/download/v${version}/${ASSET_NAMES[asset]}`

export const checkHerdr = (path: string, want: string): Result => {
  const found = sumAt(path)
  if (found === want) return { code: 0, line: `herdr pinned at ${path}` }
  return {
    code: 1,
    line: found
      ? `herdr-pin: ${path} has sha256 ${found}, not the pinned ${want}; run playground herdr pin`
      : `herdr-pin: ${path} is missing; run playground herdr pin`,
  }
}

// Exits: 0 pinned or already pinned, 2 a sum that is not the pin's, 3 no pinned asset for this machine, 4 a download that failed; nothing reaches the path but a file with the pinned sum.
export async function pinHerdr(opts: {
  asset: string | null
  download: () => Promise<Uint8Array>
  path: string
  sha256: string
  version: string
}): Promise<Result> {
  const { asset, path, version } = opts
  if (!asset)
    return {
      code: 3,
      line: `herdr-pin: Playground pins herdr only for macOS or Linux, on arm64 or x64, not ${process.platform} ${process.arch}`,
    }
  if (sumAt(path) === opts.sha256)
    return { code: 0, line: `herdr ${version} already pinned at ${path}` }
  let bytes: Uint8Array
  try {
    bytes = await opts.download()
  } catch (error) {
    return { code: 4, line: `herdr-pin: ${(error as Error).message}` }
  }
  const got = sha256(bytes)
  if (got !== opts.sha256)
    return {
      code: 2,
      line: `herdr-pin: ${asset} ${version} has sha256 ${got}, not the pinned ${opts.sha256}; nothing was installed`,
    }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    await Bun.write(temp, bytes)
    chmodSync(temp, 0o755)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
  return { code: 0, line: `herdr ${version} pinned at ${path}` }
}

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url).catch((error: Error) => {
    throw new Error(`${url} could not be fetched: ${error.message}`)
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const USAGE = "usage: herdr-pin.ts [--check] [--asset <file>]"

// The command's words, or null when it takes none of them.
const parse = (words: string[]): { asset?: string; check: boolean } | null => {
  if (words.length === 1 && words[0] === "--check") return { check: true }
  if (words.length === 2 && words[0] === "--asset" && words[1])
    return { asset: words[1], check: false }
  return words.length === 0 ? { check: false } : null
}

// The pin for this machine: its release asset downloaded, or the file given, into Playground's own path.
export const pinHere = (file?: string): Promise<Result> => {
  const asset = assetOf()
  return pinHerdr({
    asset,
    download: file
      ? async () => readFileSync(file)
      : () => download(releaseUrl(PIN_SOURCE.version, asset!)),
    path: herdrPath(),
    sha256: asset ? pinnedSum(asset) : "",
    version: PIN_SOURCE.version,
  })
}

export async function runHerdrPin(words: string[]): Promise<number> {
  const args = parse(words)
  if (!args) {
    console.error(USAGE)
    return 2
  }
  const asset = assetOf()
  const result = args.check
    ? checkHerdr(herdrPath(), asset ? pinnedSum(asset) : "")
    : await pinHere(args.asset)
  ;(result.code === 0 ? console.log : console.error)(result.line)
  return result.code
}

if (import.meta.main) process.exit(await runHerdrPin(process.argv.slice(2)))
