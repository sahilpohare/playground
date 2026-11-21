import { join } from "node:path"

import {
  HEX64,
  PEER_INSTALL_TEXT,
  ROOT_BASE,
  ROOT_DIR,
  ROOT_NAMES,
  ROOT_STEPS,
} from "@packages/config/inbox"
import type { Peer } from "@packages/config/org"

import { PLAYGROUND_SERVICE } from "../keychain-items"
import { type RootScript, SCRIPTS_DIR } from "./root"

// Root steps on a peer machine in org.cluster, which has no desktop to show a password window: the install runs once through sudo, its password read from a secret card's item and passed on stdin alone, and writes a polkit rule, so each later step runs over ssh through pkexec with no password.

// The folder in the ssh user's own home the install copies the scripts into: nothing there is root's, and the install checks each copy against the card's hash.
export const PEER_STAGE = ".cache/playground-root"

// A peer's ssh waits this long to connect; a run past ROOT_TIMEOUT_MS is stopped as a local one is.
const CONNECT = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]

// Pure: the secret store item a peer's admin password is kept in for its one install, a playground- service a secret card's keychain sink takes.
export const peerSecret = (machine: string): string => {
  const service = `playground-${machine.toLowerCase()}-sudo`
  if (!PLAYGROUND_SERVICE.test(service))
    throw new Error(`${machine} has no name a secret store item can take`)
  return service
}

// Pure: the one peer org.cluster names by this name, or a refusal, so a card names a machine and never a host.
export const peerOf = (machine: string, peers: readonly Peer[]): Peer => {
  const peer = peers.find((each) => each.name === machine)
  if (!peer) throw new Error(`${machine} is not a machine this Dashboard reaches`)
  return peer
}

// Pure: text as one word for a POSIX shell, single-quoted, each single quote closed, escaped and opened again.
export const shQuote = (text: string): string => `'${text.split("'").join(`'"'"'`)}'`

const identity = (key: string | undefined) => (key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : [])

// Pure: ssh to a peer, never prompting; ssh joins the words after the target into the one line the peer's login shell runs.
const sshArgv = (peer: Peer, key: string | undefined, ...command: string[]): string[] => [
  "ssh",
  ...identity(key),
  ...CONNECT,
  peer.target,
  ...command,
]

// Pure: the two runs that put this checkout's scripts in the peer's stage, as the ssh user.
export const peerCopyArgv = (
  peer: Peer,
  key: string | undefined,
  src: string = SCRIPTS_DIR,
): string[][] => [
  sshArgv(peer, key, "mkdir", "-p", PEER_STAGE),
  [
    "scp",
    ...identity(key),
    ...CONNECT,
    ...ROOT_NAMES.map((name) => join(src, name)),
    `${peer.target}:${PEER_STAGE}/`,
  ],
]

// Pure: the peer's install, or a refusal: every listed script once in order, each hash 64 lowercase hex; sudo reads the password from stdin with no prompt and no cached ticket, and PEER_INSTALL_TEXT reaches sh as one quoted word.
export const peerInstallArgv = (
  peer: Peer,
  key: string | undefined,
  scripts: readonly RootScript[],
): string[] => {
  if (scripts.map((script) => script.name).join(" ") !== ROOT_NAMES.join(" "))
    throw new Error(`An install lists ${ROOT_NAMES.join(", ")}, in that order`)
  const bad = scripts.find((script) => !HEX64.test(script.sha256))
  if (bad) throw new Error(`${bad.name}'s hash is not 64 lowercase hex`)
  return sshArgv(
    peer,
    key,
    `sudo -k -S -p '' /bin/sh -c ${shQuote(PEER_INSTALL_TEXT)} sh "$HOME/${PEER_STAGE}" ${scripts.map((script) => script.sha256).join(" ")}`,
  )
}

const listed = (name: string) => {
  if (!Object.hasOwn(ROOT_STEPS, name)) throw new Error(`${name} is not a listed root step`)
  return `${ROOT_DIR}/${name}`
}

// Pure: the read of a step's installed script on the peer before it runs: the owner, mode and kind of it and the two folders above it, then its sha256.
export const peerReadArgv = (peer: Peer, key: string | undefined, name: string): string[] => {
  const path = listed(name)
  return sshArgv(
    peer,
    key,
    "stat",
    "-c",
    "'%U %a %F %n'",
    ROOT_BASE,
    ROOT_DIR,
    path,
    ";",
    "sha256sum",
    path,
  )
}

// Pure: a step on the peer, pkexec on its one installed script with no argument, which the install's polkit rule lets run with no password.
export const peerStepArgv = (peer: Peer, key: string | undefined, name: string): string[] =>
  sshArgv(peer, key, "/usr/bin/pkexec", "--disable-internal-agent", listed(name))

// Pure: why a step's installed script on the peer must not run, from peerReadArgv's output, or undefined: as installedRefusal holds here, it and the two folders above it are root's and changed by root alone, it is a plain file, and it holds this checkout's bytes.
export const peerInstalledRefusal = (
  out: string,
  name: string,
  sha256: string,
): string | undefined => {
  const path = listed(name)
  const lines = out.split("\n").map((line) => line.trim())
  for (const each of [ROOT_BASE, ROOT_DIR, path]) {
    const line = lines.find((one) => one.endsWith(` ${each}`))
    const found = line && /^(\S+) ([0-7]+) (.+) \/\S+$/.exec(line)
    if (!found) return `${each} is not there: approve a new install card`
    const [, owner, mode, kind] = found
    if (kind === "symbolic link") return `${each} is a link: approve a new install card`
    if (owner !== "root") return `${each} is not owned by root: approve a new install card`
    if (Number.parseInt(mode ?? "", 8) & 0o022)
      return `${each} can be changed by others than root: approve a new install card`
    if (each === path && kind !== "regular file")
      return `${each} is not a file: approve a new install card`
  }
  const sum = lines.find((line) => line.endsWith(`  ${path}`))?.split(" ")[0]
  return sum === sha256 ? undefined : `${path} is an older copy: approve a new install card`
}
