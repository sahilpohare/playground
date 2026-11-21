import { lstat } from "node:fs/promises"
import { join } from "node:path"

import {
  CA_MAX_BYTES,
  HEX64,
  INSTALL_TEXT,
  ROOT_DIR,
  ROOT_NAMES,
  ROOT_STEPS,
  type RootStep,
} from "@packages/config/inbox"

import { portlessDir } from "../dev/proxy"

// This checkout's copies, which the install copies from and a step's stale check reads.
export const SCRIPTS_DIR = join(import.meta.dir, "root")

// pkexec asks for the password in the desktop's own window; with its internal agent off it never asks in a terminal (onboard/fix.ts's adminArgv).
export const PKEXEC = ["/usr/bin/pkexec", "--disable-internal-agent"] as const

// A root step's wait: the password window waits on the owner, so it runs in the background (answerItem) for up to this long.
export const ROOT_TIMEOUT_MS = 5 * 60_000

export type RootScript = { name: RootStep; sha256: string }

const sha256Of = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")

// Each listed script's name and sha256 as this checkout holds it now, in ROOT_NAMES' order: what an install card shows and passes.
export const repoScripts = async (dir: string = SCRIPTS_DIR): Promise<RootScript[]> =>
  Promise.all(ROOT_NAMES.map(async (name) => ({ name, sha256: await sha256Of(join(dir, name)) })))

// The Dashboard's CA, the one portless serves under: what an install card pins and its Approve copies.
export const caFile = (): string => join(portlessDir(), "ca.pem")

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g

// The sha256 of a CA file's one certificate as DER, the fingerprint a browser shows and the install checks; undefined when the file is missing, over CA_MAX_BYTES or holds other than one certificate, as the install would refuse it.
export const caPin = async (path: string = caFile()): Promise<string | undefined> => {
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size > CA_MAX_BYTES) return undefined
  const blocks = [...(await file.text()).matchAll(PEM_BLOCK)]
  if (blocks.length !== 1) return undefined
  const der = Buffer.from(blocks[0]![1]!.replace(/\s/g, ""), "base64")
  return new Bun.CryptoHasher("sha256").update(der).digest("hex")
}

// Pure: the install's argv, or a refusal: every listed script once in order, each hash 64 lowercase hex, the scripts folder this checkout's, then the CA's path and hash when the card pinned one, and nothing else.
export const installArgv = (
  scripts: readonly RootScript[],
  src: string = SCRIPTS_DIR,
  ca?: { path: string; sha256: string },
): string[] => {
  const names = scripts.map((script) => script.name)
  if (names.join(" ") !== ROOT_NAMES.join(" "))
    throw new Error(`An install lists ${ROOT_NAMES.join(", ")}, in that order`)
  const bad = scripts.find((script) => !HEX64.test(script.sha256))
  if (bad) throw new Error(`${bad.name}'s hash is not 64 lowercase hex`)
  if (!src.startsWith("/")) throw new Error("The scripts folder is not an absolute path")
  if (ca && !HEX64.test(ca.sha256)) throw new Error("The CA's hash is not 64 lowercase hex")
  if (ca && !ca.path.startsWith("/")) throw new Error("The CA's path is not absolute")
  return [
    ...PKEXEC,
    "/bin/sh",
    "-c",
    INSTALL_TEXT,
    "sh",
    src,
    ...scripts.map((script) => script.sha256),
    ...(ca ? [ca.path, ca.sha256] : []),
  ]
}

// Pure: a step's argv: pkexec on its one installed script, with no argument; a name off the list, or any argument, is refused.
export const stepArgv = (name: string, ...args: unknown[]): string[] => {
  if (args.length > 0) throw new Error("A root step takes no argument")
  if (!Object.hasOwn(ROOT_STEPS, name)) throw new Error(`${name} is not a listed root step`)
  return [...PKEXEC, `${ROOT_DIR}/${name}`]
}

const owned = async (path: string, owner: number): Promise<string | undefined> => {
  const stat = await lstat(path).catch(() => null)
  if (!stat) return `${path} is not there`
  if (stat.isSymbolicLink()) return `${path} is a link`
  if (stat.uid !== owner) return `${path} is not owned by root`
  if (stat.mode & 0o022) return `${path} can be changed by others than root`
  return undefined
}

// Why a step's installed script must not run, or undefined: it, its folder and the folder above are owned by root and changed by root alone, and it matches this checkout's copy, so a stale install refuses rather than run old code. dir, repo and owner are a test's seams.
export const installedRefusal = async (
  name: RootStep,
  { dir = ROOT_DIR, owner = 0, repo = SCRIPTS_DIR } = {},
): Promise<string | undefined> => {
  const path = join(dir, name)
  for (const each of [join(dir, ".."), dir, path]) {
    const refused = await owned(each, owner)
    if (refused) return `${refused}: approve a new install card`
  }
  return (await sha256Of(path)) === (await sha256Of(join(repo, name)))
    ? undefined
    : `${path} is an older copy: approve a new install card`
}
