import { lstat, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  PEER_POLICY,
  PEER_RULE,
  ROOT_BASE,
  ROOT_CA,
  ROOT_DIR,
  ROOT_NAMES,
  ROOT_STEPS,
  type RootStep,
} from "@packages/config/inbox"
import { factoryHomes, readPolicyOrDefaults, writeAtomically } from "@packages/settings"

// This file imports node and the workspace packages alone, since the API imports it (@packages/scripts/machine-record/record) and its type build emits no file a relative import reaches.

// The machine record: every path the factory put on this machine, one JSON file in the data folder, and the daily check that names what it does not hold. "Footprint" stays a session's processes (api/hono/src/lib/system/footprint.ts).

export const RECORD_FILE = "machine-record.json"

export const KINDS = ["container", "file", "folder", "image", "link"] as const
export type Kind = (typeof KINDS)[number]

export type Entry = {
  added: string
  by: string
  kind: Kind
  path: string
  undo: string
  why: string
}

// baseline: what the watched places held at the seed, so the first check names only what came after.
export type MachineRecord = { baseline: string[]; entries: Entry[] }

export type Run = (argv: string[]) => Promise<{ code: number; out: string }>

// What a check reads: the home folder, the factory's homes as absolute paths (factoryHomes), the root-step folders, the root-only ones among them and docker through run, each a test's seam.
export type Places = {
  home: string
  homes: string[]
  rootOnly?: string[]
  run: Run
  system?: string[]
}

// The folders a root step writes into, from ROOT_STEPS and the peer install's polkit files.
export const ROOT_FOLDERS: string[] = [
  ...new Set([
    ROOT_BASE,
    ROOT_DIR,
    dirname(ROOT_CA),
    dirname(PEER_POLICY),
    dirname(PEER_RULE),
    ...Object.values(ROOT_STEPS).flatMap((step) => step.adds.map((path) => dirname(path))),
  ]),
].sort()

// The watched folders root-only by design: polkit's rules folder is root:polkitd 0750, where the install leaves every other root-step folder 0755, so only these read as known when the user cannot list them.
export const ROOT_ONLY: string[] = [dirname(PEER_RULE)]

// spawn.sh's --ssh probe folder on the peer: a temp folder under /tmp, which no watched place holds, so the check skips it.
export const TEMP_PREFIX = "/tmp/playground-"

// The folders whose entries the check lists, the home folder's top level first.
export const watchedFolders = (home: string, system: string[] = ROOT_FOLDERS): string[] => [
  home,
  ...[".bun/bin", ".cache", ".config", ".config/systemd/user", ".local/bin"].map((rel) =>
    join(home, rel),
  ),
  ...system,
]

// The allowed homes on this machine: paths.factoryHomes as the data folder's policy sets it, else its default.
export const homesOf = (data: string, checkout: string, home: string): string[] =>
  factoryHomes(readPolicyOrDefaults(data).settings ?? { schemaVersion: 1, values: {} }, {
    checkout,
    data,
    home,
  })

export const recordPath = (data: string): string => join(data, RECORD_FILE)

const isEntry = (value: unknown): value is Entry => {
  const entry = value as Entry
  return (
    typeof entry === "object" &&
    entry !== null &&
    KINDS.includes(entry.kind) &&
    ["added", "by", "path", "undo", "why"].every(
      (key) => typeof entry[key as keyof Entry] === "string",
    )
  )
}

// The record, empty before the seed; a file that does not read throws, so no write replaces it.
export async function readRecord(data: string): Promise<MachineRecord> {
  const file = Bun.file(recordPath(data))
  if (!(await file.exists())) return { baseline: [], entries: [] }
  const parsed = JSON.parse(await file.text()) as Partial<MachineRecord>
  if (
    !Array.isArray(parsed.baseline) ||
    !parsed.baseline.every((path) => typeof path === "string") ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isEntry)
  )
    throw new Error(`${recordPath(data)} is not a machine record`)
  return { baseline: parsed.baseline, entries: parsed.entries }
}

// Written whole under a temp name, then renamed into place, so a reader meets the old record or the new one.
const write = async (data: string, record: MachineRecord) =>
  writeAtomically(
    recordPath(data),
    `${JSON.stringify(
      {
        baseline: [...new Set(record.baseline)].sort(),
        entries: [...record.entries].sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    )}\n`,
  )

// A path as the record keeps it: no trailing slash, so a folder named with one matches its listing.
export const plain = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

// Adds each entry whose path the record lacks and returns their paths; a path it holds already changes nothing, and with nothing new the file is not written.
export async function addEntries(data: string, entries: Entry[]): Promise<string[]> {
  const record = await readRecord(data)
  const held = new Set(record.entries.map((entry) => entry.path))
  const added: Entry[] = []
  for (const entry of entries) {
    const path = plain(entry.path)
    if (held.has(path)) continue
    held.add(path)
    added.push({ ...entry, path })
  }
  if (added.length) await write(data, { ...record, entries: [...record.entries, ...added] })
  return added.map((entry) => entry.path)
}

// Drops each named path from the record and returns those it held; with none held, the file is not written.
export async function dropPaths(data: string, paths: string[]): Promise<string[]> {
  const record = await readRecord(data)
  const gone = new Set(paths.map(plain))
  const dropped = record.entries.filter((entry) => gone.has(entry.path)).map((entry) => entry.path)
  if (dropped.length)
    await write(data, { ...record, entries: record.entries.filter((e) => !gone.has(e.path)) })
  return dropped
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code

// A folder's entries as paths; a folder that is not there holds none, and one that cannot be read is unreadable.
const listed = async (folder: string): Promise<string[] | "unreadable"> => {
  try {
    return (await readdir(folder)).map((name) => join(folder, name))
  } catch (error) {
    return ["EACCES", "EPERM"].includes(errno(error) ?? "") ? "unreadable" : []
  }
}

// Docker's images and containers as the record names them, null when docker is there but does not answer, none with no docker.
const dockerItems = async (run: Run): Promise<string[] | null> => {
  const none = { code: 127, out: "" }
  const images = await run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]).catch(
    () => none,
  )
  if (images.code === 127) return []
  const containers = await run(["docker", "ps", "-a", "--format", "{{.Names}}"]).catch(() => none)
  if (images.code !== 0 || containers.code !== 0) return null
  const words = (out: string) => out.split("\n").map((line) => line.trim())
  return [
    ...words(images.out)
      .filter((ref) => ref && !ref.includes("<none>"))
      .map((ref) => `docker image ${ref}`),
    ...words(containers.out)
      .filter(Boolean)
      .map((name) => `docker container ${name}`),
  ]
}

export const DOCKER_UNREAD = "docker images and containers"

// What the watched places hold now, each root-only place the user cannot read (known, with its reason), and each place the check should read but cannot.
export async function snapshot(
  places: Places,
): Promise<{ seen: string[]; known: string[]; unreadable: string[] }> {
  const seen: string[] = []
  const known: string[] = []
  const unreadable: string[] = []
  const rootOnly = new Set(places.rootOnly ?? ROOT_ONLY)
  for (const folder of watchedFolders(places.home, places.system)) {
    const entries = await listed(folder)
    if (entries === "unreadable") {
      if (rootOnly.has(folder)) known.push(folder)
      else unreadable.push(folder)
    } else seen.push(...entries)
  }
  const docker = await dockerItems(places.run)
  if (docker === null) unreadable.push(DOCKER_UNREAD)
  else seen.push(...docker)
  return { seen: [...new Set(seen)].sort(), known: known.sort(), unreadable }
}

const inside = (path: string, home: string) => path === home || path.startsWith(`${home}/`)

// Why a known root-only place is not listed: the check runs as the user and no root helper exists on this machine to read it, so its listing is skipped, not a loss.
const ROOT_ONLY_REASON = "no root helper on this machine, so its listing is skipped"

// Pure: one line per finding: a new path no entry holds, misplaced outside the factory's homes and unrecorded inside them (a docker item has no place, so it is unrecorded); a recorded path that is gone; each root-only place the user cannot read, named as known with its reason, and a recorded path in one, which is then not named again; and each place or path the check should read but cannot, which is neither gone nor new, so it is named every run and never hides a loss.
export function findings(
  record: MachineRecord,
  now: { seen: string[]; known: string[]; unreadable: string[] },
  stat: Map<string, "gone" | "here" | "unreadable">,
  homes: string[],
): string[] {
  const held = new Set(record.entries.map((entry) => entry.path))
  const before = new Set(record.baseline)
  const lines: string[] = []
  for (const path of now.seen) {
    if (held.has(path) || before.has(path)) continue
    const placed = path.startsWith("/") && !homes.some((home) => inside(path, home))
    lines.push(`${placed ? "misplaced" : "unrecorded"}: ${path}`)
  }
  for (const entry of record.entries) {
    const state = stat.get(entry.path)
    if (state === "gone") lines.push(`gone: ${entry.path}`)
  }
  for (const path of now.known) lines.push(`root-only: ${path}, ${ROOT_ONLY_REASON}`)
  const unread = [
    ...now.unreadable,
    ...record.entries
      .filter((e) => stat.get(e.path) === "unreadable" && !now.known.includes(dirname(e.path)))
      .map((e) => e.path),
  ]
  for (const path of [...new Set(unread)]) lines.push(`unreadable: ${path}`)
  return lines
}

// Whether each recorded entry is still there: a path by lstat (a path whose folder cannot be read is unreadable), a docker item by the snapshot, unreadable while docker does not answer.
async function states(
  record: MachineRecord,
  now: { seen: string[]; unreadable: string[] },
): Promise<Map<string, "gone" | "here" | "unreadable">> {
  const seen = new Set(now.seen)
  const dockerDown = now.unreadable.includes(DOCKER_UNREAD)
  const out = new Map<string, "gone" | "here" | "unreadable">()
  for (const { path } of record.entries) {
    if (path.startsWith("docker ")) {
      out.set(path, dockerDown ? "unreadable" : seen.has(path) ? "here" : "gone")
      continue
    }
    try {
      await lstat(path)
      out.set(path, "here")
    } catch (error) {
      out.set(path, errno(error) === "ENOENT" ? "gone" : "unreadable")
    }
  }
  return out
}

// The check: the record against what the watched places hold now, as findings' lines; a root-only folder the user cannot list and the record holds no path in gets no line, since nothing of the factory's sits there to read.
export async function check(data: string, places: Places): Promise<string[]> {
  const record = await readRecord(data)
  const now = await snapshot(places)
  const known = now.known.filter((folder) => record.entries.some((e) => dirname(e.path) === folder))
  return findings(record, { ...now, known }, await states(record, now), places.homes)
}

// The peer install's staging folder in the ssh user's home (api/hono/src/lib/system/peer-root.ts's PEER_STAGE), as a ~/ path the peer's own add reads under its home.
export const PEER_STAGE_PATH = "~/.cache/playground-root"

// Pure: what an Inbox root card that ran puts on its machine, as entries: an install's folders and scripts under ROOT_BASE (on a peer also its polkit files and its staging folder), or a step's own paths from ROOT_STEPS.
export function rootEntries(
  step: "install" | RootStep,
  { ca = false, now, peer }: { ca?: boolean; now: Date; peer: boolean },
): Entry[] {
  const added = now.toISOString()
  const entry = (path: string, kind: Kind, undo: string): Entry => ({
    added,
    by: "the Inbox",
    kind,
    path,
    undo,
    why: `the Inbox's root ${step === "install" ? "install" : `step ${step}`}`,
  })
  if (step !== "install")
    return ROOT_STEPS[step].adds.map((path) => entry(path, "file", ROOT_STEPS[step].undo))
  return [
    entry(
      ROOT_BASE,
      "folder",
      `remove ${ROOT_BASE} and what it holds, as root, once every step's own undo has run`,
    ),
    entry(ROOT_DIR, "folder", `remove ${ROOT_DIR} and the scripts in it, as root`),
    entry(dirname(ROOT_CA), "folder", `remove ${dirname(ROOT_CA)} and the CA in it, as root`),
    ...ROOT_NAMES.map((name) =>
      entry(`${ROOT_DIR}/${name}`, "file", `sudo rm ${ROOT_DIR}/${name}`),
    ),
    ...(ca ? [entry(ROOT_CA, "file", `sudo rm ${ROOT_CA}`)] : []),
    ...(peer
      ? [
          entry(PEER_POLICY, "file", `sudo rm ${PEER_POLICY}`),
          entry(PEER_RULE, "file", `sudo rm ${PEER_RULE}`),
          entry(PEER_STAGE_PATH, "folder", `remove ${PEER_STAGE_PATH} and the script copies in it`),
        ]
      : []),
  ]
}

// The record CLI in a clone, by its path from the clone's root.
export const RECORD_CLI = "packages/scripts/src/machine-record/cli.ts"

// Pure: the one ssh argv that reaches a peer's record: its check, or its add with the entries on stdin; the key alone, no prompt and none of the user's ssh config, the CLI run from the peer's clone at clone (a ~/ path cloneOf checked, @packages/config/org) with its own ~/.bun/bin on PATH, as ops-peer-relay's sshArgs runs agent.ts there.
export const peerRecordArgv = (
  key: string | undefined,
  target: string,
  clone: string,
  verb: "add" | "check",
): string[] =>
  peerArgv(key, target, clone, `${RECORD_CLI} ${verb === "add" ? "add --stdin" : "check"}`)

// The one ssh a factory script runs on a peer: no ssh config, the factory's key alone when given, never prompting, a 10-second connect, then `bun --no-env-file <command>` in the peer's clone.
export const peerArgv = (
  key: string | undefined,
  target: string,
  clone: string,
  command: string,
): string[] => [
  "ssh",
  "-F",
  "none",
  ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []),
  ...["BatchMode=yes", "ConnectTimeout=10"].flatMap((option) => ["-o", option]),
  target,
  `cd ${clone} && PATH="$HOME/.bun/bin:$PATH" exec bun --no-env-file ${command}`,
]

// The seed: the record takes each entry the notes list for this machine, and the watched places' listing now as its baseline, so the first check names only what comes after.
export async function seed(data: string, entries: Entry[], places: Places): Promise<number> {
  const added = await addEntries(data, entries)
  const record = await readRecord(data)
  await write(data, { ...record, baseline: (await snapshot(places)).seen })
  return added.length
}
