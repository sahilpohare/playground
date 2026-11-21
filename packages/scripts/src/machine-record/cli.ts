import { homedir, hostname } from "node:os"
import { join } from "node:path"

import { dataDir } from "@packages/env/data-dir"

import { mainCheckout } from "../main-checkout"
import { FOOTPRINT_NOTE, seedEntries, undoNote } from "./notes"
import {
  addEntries,
  check,
  dropPaths,
  type Entry,
  homesOf,
  KINDS,
  type Kind,
  type Places,
  type Run,
  seed,
} from "./record"

// playground record: the machine record's four subcommands, also run straight from a clone (a peer's check and add over ssh, link-skills.sh's add).

export const USAGE = `usage: playground record add <path> --kind <${KINDS.join("|")}> --why "<why>" --undo "<undo>" [--by <who>]
       playground record add --stdin            (a JSON list of entries, the form a peer's add takes over ssh)
       an undo with a delete word (rm, rmdir, docker rm -fv) goes in through --stdin < entry.json, a JSON list holding the entry, since the no-raw-delete hook reads a quoted --undo value as a command
       playground record drop <path>
       playground record seed [--machine <name>] [--notes <folder>]
       playground record check

seed reads footprint.md's tree: a comma list's later item that names a folder of its own is read
from the first item's parent, so in "kit/a.sh, b.sh, logs/c.sh" b.sh is kit/b.sh and logs/c.sh is
logs/c.sh beside kit/; write every item with its full prefix ("kit/a.sh, kit/b.sh, kit/logs/c.sh").`

export type RecordIo = {
  data: string
  err: (line: string) => void
  home: string
  machine: string
  now: () => Date
  out: (line: string) => void
  places: () => Places
  stdin: () => Promise<string>
}

const run: Run = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stderr: "pipe", stdin: "ignore", stdout: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { code, out }
  } catch {
    return { code: 127, out: "" }
  }
}

export const recordIo = (): RecordIo => {
  const data = dataDir()
  const home = process.env.HOME || homedir()
  return {
    data,
    err: console.error,
    home,
    machine: hostname().split(".")[0]!,
    now: () => new Date(),
    out: console.log,
    places: () => ({
      home,
      homes: homesOf(data, mainCheckout(), home),
      run,
    }),
    stdin: () => Bun.stdin.text(),
  }
}

// Each --flag's value, and the words that are no flag's.
const flags = (words: string[]): { bare: string[]; named: Map<string, string> } => {
  const named = new Map<string, string>()
  const bare: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === "--stdin") named.set("stdin", "")
    else if (word.startsWith("--") && i + 1 < words.length) named.set(word.slice(2), words[++i]!)
    else bare.push(word)
  }
  return { bare, named }
}

const usage = (io: RecordIo, why: string): number => {
  io.err(`playground record: ${why}\n${USAGE}`)
  return 2
}

const entryOf = (value: unknown, io: RecordIo): Entry | string => {
  const v = value as Partial<Record<keyof Entry, unknown>>
  if (typeof v?.path !== "string") return "an entry needs a path"
  const path = v.path.startsWith("~/") ? `${io.home}/${v.path.slice(2)}` : v.path
  if (!/^(?:\/|docker (?:container|image) \S)/.test(path))
    return `${path}: a path is absolute, ~/ or a docker image or container`
  if (!KINDS.includes(v.kind as Kind)) return `${path}: kind is one of ${KINDS.join(", ")}`
  if (typeof v.why !== "string" || !v.why) return `${path}: an entry needs its why`
  if (typeof v.undo !== "string" || !v.undo) return `${path}: an entry needs its undo`
  return {
    added: io.now().toISOString(),
    by: typeof v.by === "string" && v.by ? v.by : "hand",
    kind: v.kind as Kind,
    path,
    undo: v.undo,
    why: v.why,
  }
}

// add, drop, seed or check: 0 done, 1 a finding or a failure, 2 a usage error.
export async function runRecord(words: string[], io: RecordIo): Promise<number> {
  const [verb, ...rest] = words
  if (verb === "--help" || verb === "-h" || verb === "help") {
    io.out(USAGE)
    return 0
  }
  const { bare, named } = flags(rest)
  if (verb === "add") {
    let values: unknown[]
    if (named.has("stdin")) {
      try {
        const parsed: unknown = JSON.parse(await io.stdin())
        if (!Array.isArray(parsed)) return usage(io, "--stdin takes a JSON list of entries")
        values = parsed
      } catch {
        return usage(io, "--stdin's text is not JSON")
      }
    } else {
      if (bare.length !== 1) return usage(io, "add takes one path")
      values = [
        {
          by: named.get("by"),
          kind: named.get("kind"),
          path: bare[0],
          undo: named.get("undo"),
          why: named.get("why"),
        },
      ]
    }
    const entries: Entry[] = []
    for (const value of values) {
      const entry = entryOf(value, io)
      if (typeof entry === "string") return usage(io, entry)
      entries.push(entry)
    }
    const added = await addEntries(io.data, entries)
    for (const path of added) io.out(`recorded ${path}`)
    if (!added.length) io.out("already recorded")
    return 0
  }
  if (verb === "drop") {
    if (bare.length !== 1) return usage(io, "drop takes one path")
    const dropped = await dropPaths(io.data, bare)
    io.out(dropped.length ? `dropped ${dropped[0]}` : `${bare[0]} is not in the record`)
    return dropped.length ? 0 : 1
  }
  if (verb === "seed") {
    if (bare.length) return usage(io, "seed takes no path")
    const notes = named.get("notes") ?? join(io.data, "bundles")
    const machine = named.get("machine") ?? io.machine
    // a machine with no undo note of its own takes each undo as a pointer to the notes
    const undo = Bun.file(join(notes, undoNote(machine)))
    const { entries, skipped } = seedEntries(
      await Bun.file(join(notes, FOOTPRINT_NOTE)).text(),
      (await undo.exists()) ? await undo.text() : "",
      machine,
      io.home,
      io.now(),
    )
    for (const item of skipped)
      io.err(
        `playground record: skipped ${item}: not one plain path on this machine, so add it by hand`,
      )
    if (!entries.length) {
      io.err(`playground record: ${join(notes, FOOTPRINT_NOTE)} lists no path for ${machine}`)
      return 1
    }
    const added = await seed(io.data, entries, io.places())
    io.out(`seeded ${added} of ${entries.length} paths for ${machine}, and the baseline`)
    return 0
  }
  if (verb === "check") {
    if (bare.length) return usage(io, "check takes no path")
    const lines = await check(io.data, io.places())
    for (const line of lines) io.out(line)
    return lines.length ? 1 : 0
  }
  return usage(io, verb === undefined ? "a subcommand is needed" : `no subcommand ${verb}`)
}

if (import.meta.main) process.exit(await runRecord(process.argv.slice(2), recordIo()))
