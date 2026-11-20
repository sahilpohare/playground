import { lstatSync, readdirSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, join, sep } from "node:path"

import { cloneOf } from "@packages/config/org"
import { dataDir } from "@packages/env/data-dir"
import { bytesOf } from "@packages/safe-delete"

import { type Entry, peerArgv, readRecord, type Run } from "../machine-record/record"
import { mainCheckout } from "../main-checkout"
import { peersOf } from "./peers"

// The unused space nightly-clean lists on each machine, its card removing only what the owner picks Remove for (unused-card.ts): model weights no model folder names, Docker images no container uses, model-test replay worktrees past their row's end, and ship rehearsals in a scratchpad. It only reads, here and on a peer over one fixed ssh, and an item the machine record holds is marked recorded.

// Ops' cleanup list, Thresholds (bundles/cleanup-list.md): an image no container uses and not pulled or run in 7 days is unused.
export const IMAGE_UNUSED_DAYS = 7
// Ops' cleanup list, Thresholds: an item under 100 MB folds into one small leftovers total.
export const MIN_LIST_BYTES = 100 * 1024 ** 2
// Ops' cleanup list, Thresholds: a replay worktree is unused 24 hours after its row ends, read as the row's newest result file.
export const RUN_WORKTREE_AGE_MS = 24 * 3_600_000
// Ops' cleanup list, Thresholds: the image a live job names stays, such as the merge lock's.
export const KEEP_IMAGES = ["redis:alpine"]

export const UNUSED_CLI = "packages/scripts/src/ops-tick/unused.ts"
const WEIGHTS = /\.(gguf|safetensors)$/
// A sharded weights file: its stem, shard index and total (5-digit, so a lexicographic order is a numeric one) and extension.
export const SHARD = /^(.+)-(\d{5})-of-(\d{5})\.(gguf|safetensors)$/
const REHEARSAL = /^rehearse\d+$/

export const KINDS = ["image", "rehearsal", "run", "weights"] as const
export type UnusedKind = (typeof KINDS)[number]
// unknownAge: an image with no last tag time, listed by nightly-clean only once its own first-seen date is IMAGE_UNUSED_DAYS old.
export type Unused = {
  bytes: number
  id?: string
  kind: UnusedKind
  path: string
  recorded: boolean
  shards?: string[]
  unknownAge?: true
}
// What one machine's measure gives: its items, and imagesUnread when docker did not answer, so a night that cannot read the images keeps their first-seen nights.
export type Measured = { imagesUnread?: true; items: Unused[] }
export type Machine = (Measured & { machine: string }) | { machine: string; why: string }

// What a measure reads: the data folder (its record and scratchpads), the home folder (~/models), the clock and docker through run.
export type Places = { data: string; home: string; now: number; run: Run }

const lines = (out: string): string[] => out.split("\n").filter((l) => l.trim())
const stat = (path: string) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep)

// Each weights file (.gguf, .safetensors) under dir, past .git, node_modules and the skip folders, read through no symlink.
const weightFiles = (dir: string, skip: string[]): string[] =>
  list(dir).flatMap((name) => {
    const path = join(dir, name)
    const st = stat(path)
    if (!st || skip.includes(path)) return []
    if (st.isDirectory())
      return name === ".git" || name === "node_modules" ? [] : weightFiles(path, skip)
    return st.isFile() && WEIGHTS.test(name) ? [path] : []
  })

// The text of every model folder's serve.sh and model.env, ~/models/<model>/ and ~/models/trial/<model>/, which names each repo and image a model keeps.
const modelTexts = async (models: string): Promise<string> => {
  const folders = [
    ...list(models).map((name) => join(models, name)),
    ...list(join(models, "trial")).map((name) => join(models, "trial", name)),
  ]
  const texts = await Promise.all(
    folders.flatMap((dir) =>
      ["model.env", "serve.sh"].map((name) =>
        Bun.file(join(dir, name))
          .text()
          .catch(() => ""),
      ),
    ),
  )
  return texts.join("\n")
}

// Weights no model folder names: each repo in ~/models/hf/hub (models--<org>--<name>) whose <org>/<name> no model text holds, then each weights file elsewhere under ~/models (past hf/ and the test kit) or in a recorded folder outside the data folder and the home's dot folders.
const weights = (home: string, folders: string[], data: string, named: string): string[] => {
  const models = join(home, "models")
  const hub = join(models, "hf", "hub")
  const repos = list(hub)
    .filter((name) => name.startsWith("models--"))
    .filter((name) => !named.includes(name.slice("models--".length).replace("--", "/")))
    .map((name) => join(hub, name))
  const roots = [
    models,
    ...folders.filter(
      (f) => f !== home && !inside(f, models) && !inside(f, data) && !basename(f).startsWith("."),
    ),
  ]
  const files = [
    ...new Set(
      roots.flatMap((root) => weightFiles(root, [join(models, "hf"), join(models, "kit")])),
    ),
  ]
  return [...repos, ...files]
}

// Pure: the images no container uses, by id, so one tag in use keeps every tag of its image, and no model text or KEEP_IMAGES names; each as `docker image <ref>`, the record's form, its tags A to Z, with its bytes. An image docker gives a last tag time stays while that time is past the cutoff; one whose time is zero, as a pull leaves it, has no age docker knows and is marked unknownAge, for nightly-clean's own first-seen date to judge. inspect is `docker image inspect`'s lines of id, size and last tag time in JSON.
export const unusedImages = (
  listed: string,
  used: string,
  inspect: string,
  named: string,
  cutoff: number,
): { bytes: number; id: string; path: string; unknownAge?: true }[] => {
  const usedBy = new Set(lines(used).map((ref) => ref.trim()))
  const facts = new Map(
    lines(inspect).map((l) => {
      const [id = "", size = "0", at = '""'] = l.split("\t")
      return [id, { at: Date.parse(JSON.parse(at) as string) || 0, bytes: Number(size) }]
    }),
  )
  const refsOf = new Map<string, string[]>()
  for (const l of lines(listed)) {
    const [id = "", ref = ""] = l.split("\t")
    if (ref !== "<none>:<none>") refsOf.set(id, [...(refsOf.get(id) ?? []), ref])
  }
  return [...refsOf].flatMap(([id, refs]) => {
    const fact = facts.get(id)
    const names = refs.flatMap((ref) => [ref, ref.replace(/:latest$/, "")])
    const inUse =
      [id, ...names].some((name) => usedBy.has(name)) ||
      [...usedBy].some((u) => id.startsWith(`sha256:${u}`))
    if (!fact || inUse || refs.some((ref) => KEEP_IMAGES.includes(ref) || named.includes(ref)))
      return []
    if (fact.at >= cutoff) return []
    const path = `docker image ${[...refs].sort()[0]}`
    return [
      fact.at > 0
        ? { bytes: fact.bytes, id, path }
        : { bytes: fact.bytes, id, path, unknownAge: true as const },
    ]
  })
}

const images = async (places: Places, named: string) => {
  const listed = await places.run([
    "docker",
    "image",
    "ls",
    "--no-trunc",
    "--format",
    "{{.ID}}\t{{.Repository}}:{{.Tag}}",
  ])
  const used = await places.run(["docker", "ps", "-a", "--no-trunc", "--format", "{{.Image}}"])
  // no docker at all is no images; docker that does not answer is unread
  if (listed.code === 127) return []
  if (listed.code !== 0 || used.code !== 0) return null
  const ids = [...new Set(lines(listed.out).map((l) => l.split("\t")[0]!))]
  if (!ids.length) return []
  const inspect = await places.run([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}\t{{.Size}}\t{{json .Metadata.LastTagTime}}",
    ...ids,
  ])
  const cutoff = places.now - IMAGE_UNUSED_DAYS * 86_400_000
  return inspect.code === 0 ? unusedImages(listed.out, used.out, inspect.out, named, cutoff) : null
}

// Each row in ~/models/kit/runs whose newest result file is past RUN_WORKTREE_AGE_MS, as its worktree folders alone, so its grade.log, stream.jsonl and stderr stay out of the list.
const runs = (home: string, now: number): string[] => {
  const root = join(home, "models", "kit", "runs")
  return list(root).flatMap((row) => {
    const dir = join(root, row)
    const entries = list(dir).map((name) => ({ path: join(dir, name), st: stat(join(dir, name)) }))
    const results = entries.filter((e) => e.st?.isFile())
    const ended = Math.max(0, ...results.map((e) => e.st!.mtimeMs))
    if (!results.length || now - ended < RUN_WORKTREE_AGE_MS) return []
    return entries.filter((e) => e.st?.isDirectory()).map((e) => e.path)
  })
}

// Each scratchpad/<session>/rehearse<N> folder, a hand-run ship rehearsal no step removes.
const rehearsals = (data: string): string[] => {
  const pads = join(data, "scratchpad")
  return list(pads).flatMap((session) =>
    list(join(pads, session))
      .filter((name) => REHEARSAL.test(name) && stat(join(pads, session, name))?.isDirectory())
      .map((name) => join(pads, session, name)),
  )
}

// Pure: whether the record holds a path, as its own entry or a folder (or glob) it sits under.
export const recordedBy = (entries: Entry[], path: string): boolean =>
  entries.some(
    (e) => inside(path, e.path) || (e.path.includes("*") && new Bun.Glob(e.path).match(path)),
  )

// Each listed path measured, largest first; a path that is gone by its measure (removed after it was listed, such as by a delete running at the same time) is skipped, counted nowhere. An image keeps the size docker gave it.
export const measured = (
  found: { bytes?: number; id?: string; kind: UnusedKind; path: string; unknownAge?: true }[],
  entries: Entry[],
): Unused[] =>
  found
    .flatMap(({ bytes, id, kind, path, unknownAge }) => {
      const size = bytes ?? bytesOf(path)
      // read after the walk, so a path removed while it was measured is skipped too
      if (bytes === undefined && !stat(path)) return []
      const item: Unused = {
        bytes: size,
        ...(id ? { id } : {}),
        kind,
        path,
        recorded: recordedBy(entries, path),
      }
      return [unknownAge ? { ...item, unknownAge } : item]
    })
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))

// Pure: one shard set's weights into one item, every other item unchanged, sorted as measured sorts it (bytes down, then path). Each weights file whose path is `stem-<shard>-of-<total>.<ext>` groups by stem, total and extension: the stem holds the folder, the shard index is only the order. The set becomes one item, kind weights, path the lowest shard's, shards every path A to Z, bytes their sum, recorded true when any shard is recorded, so a sharded model is one line on the nightly clean, sized as the whole set.
export const shardSets = (items: Unused[]): Unused[] => {
  const sets = new Map<string, Unused[]>()
  const rest: Unused[] = []
  for (const item of items) {
    const m = item.kind === "weights" ? SHARD.exec(item.path) : null
    if (m) {
      const [, stem, , total, ext] = m
      const key = [stem, total, ext].join("\u0000")
      sets.set(key, [...(sets.get(key) ?? []), item])
    } else rest.push(item)
  }
  const merged: Unused[] = [...sets.entries()].flatMap(([, members]) => {
    const byPath = [...members].sort((a, b) => a.path.localeCompare(b.path))
    return [
      {
        bytes: members.reduce((n, i) => n + i.bytes, 0),
        kind: "weights",
        path: byPath[0]!.path,
        recorded: members.some((i) => i.recorded),
        shards: byPath.map((i) => i.path),
      },
    ]
  })
  return [...rest, ...merged].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
}

// This machine's unused space, largest first.
export async function measureUnused(places: Places): Promise<Measured> {
  const { entries } = await readRecord(places.data).catch(() => ({ entries: [] as Entry[] }))
  const folders = entries.filter((e) => e.kind === "folder").map((e) => e.path)
  const named = await modelTexts(join(places.home, "models"))
  const listed = (kind: UnusedKind, paths: string[]) => paths.map((path) => ({ kind, path }))
  const found = await images(places, named)
  const items = shardSets(
    measured(
      [
        ...(found ?? []).map((i) => ({ ...i, kind: "image" as const })),
        ...listed("rehearsal", rehearsals(places.data)),
        ...listed("run", runs(places.home, places.now)),
        ...listed("weights", weights(places.home, folders, places.data, named)),
      ],
      entries,
    ),
  )
  return found ? { items } : { imagesUnread: true, items }
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`
const tilde = (path: string, home: string) =>
  inside(path, home) ? `~${path.slice(home.length)}` : path

// Pure: a machine's two lines, the log's total by kind and the outbox's each item (null with none, so a night with nothing unused sends no line), items under min folded into one small leftovers total.
export const linesOf = (
  found: Machine,
  home: string,
  min = MIN_LIST_BYTES,
): { item: string | null; total: string } => {
  if ("why" in found)
    return { item: `${found.machine}: not read: ${found.why}`, total: `${found.machine} not read` }
  const big = found.items.filter((i) => i.bytes >= min)
  const small = found.items.filter((i) => i.bytes < min)
  const sum = (items: Unused[]) => items.reduce((n, i) => n + i.bytes, 0)
  const kinds = KINDS.flatMap((kind) => {
    const of = big.filter((i) => i.kind === kind)
    return of.length ? [`${kind} ${gb(sum(of))}`] : []
  })
  const leftovers = small.length ? [`small leftovers ${small.length} at ${mb(sum(small))}`] : []
  const total = `${found.machine} unused ${gb(sum(found.items))}${kinds.length + leftovers.length ? ` (${[...kinds, ...leftovers].join(", ")})` : ""}`
  const items = big.map(
    (i) =>
      `${i.kind} ${tilde(i.path, home)} ${gb(i.bytes)}${i.recorded ? " recorded" : ""}${i.unknownAge ? " age unknown" : ""}`,
  )
  const named = [...items, ...leftovers]
  return { item: named.length ? `${found.machine} unused: ${named.join("; ")}` : null, total }
}

// Pure: each machine's items with an unknown age judged by seen, the night each `<machine> <path>` was first read unused: listed once that night is IMAGE_UNUSED_DAYS old, dropped before; and seen as it stands after tonight, each key read now kept at its first night, a machine not read keeping its keys, and the rest dropped, so an image used again starts over.
export const aged = (
  found: Machine[],
  seen: Record<string, string>,
  now: number,
): { found: Machine[]; seen: Record<string, string> } => {
  const next: Record<string, string> = {}
  for (const m of found)
    if ("why" in m || m.imagesUnread)
      for (const [key, at] of Object.entries(seen))
        if (key.startsWith(`${m.machine} `)) next[key] = at
  const judged = found.map((m) => {
    if ("why" in m) return m
    const items = m.items.flatMap(({ unknownAge, ...item }) => {
      if (!unknownAge) return [item]
      const key = `${m.machine} ${item.path}`
      // a first night that does not read as a date (a hand edit) starts tonight
      next[key] = Number.isNaN(Date.parse(seen[key] ?? ""))
        ? new Date(now).toISOString()
        : seen[key]!
      return now - Date.parse(next[key]) >= IMAGE_UNUSED_DAYS * 86_400_000 ? [item] : []
    })
    return { ...m, items }
  })
  return { found: judged, seen: next }
}

// The one ssh a peer's measure runs through: read only, its JSON on stdout, never prompting.
export const peerUnusedArgv = (key: string | undefined, target: string, clone: string): string[] =>
  peerArgv(key, target, clone, `${UNUSED_CLI} --json`)

const PEER_MS = 10 * 60_000

// This machine's unused space, then each peer's that peersOf names, each read by peerUnusedArgv; a peer that does not answer is named with why. checkout, the Dashboard's checkout, is a test's seam.
export async function unusedEverywhere(
  places: Places,
  repo: string,
  run: (argv: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>,
  checkout?: (repo: string) => string | null,
): Promise<Machine[]> {
  const found: Machine[] = [
    { ...(await measureUnused(places)), machine: hostname().split(".")[0]! },
  ]
  const cluster = await peersOf(repo, places.home, checkout)
  if ("why" in cluster) return found
  const clone = cloneOf(repo, places.home)
  for (const peer of cluster.peers) {
    if (clone === null) {
      found.push({ machine: peer.name, why: "this checkout is not a plain path under home" })
      continue
    }
    const ran = await run(peerUnusedArgv(cluster.key, peer.target, clone), PEER_MS)
    try {
      if (ran.code !== 0) throw new Error()
      // a peer on the older array output still reads, until its clone updates
      const read = JSON.parse(ran.out) as Measured | Unused[]
      const measure = Array.isArray(read) ? { items: read } : read
      if (!Array.isArray(measure?.items)) throw new Error()
      found.push({ ...measure, machine: peer.name })
    } catch {
      found.push({ machine: peer.name, why: ran.out.trim().split("\n")[0] || `exit ${ran.code}` })
    }
  }
  return found
}

const run: Run = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stderr: "pipe", stdin: "ignore", stdout: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // stderr only on a failure, so --json's stdout parses whole
    return { code, out: code === 0 ? out : `${err}${out}` }
  } catch {
    return { code: 127, out: "" }
  }
}

export const livePlaces = (): Places => ({
  data: dataDir(),
  home: process.env.HOME || homedir(),
  now: Date.now(),
  run,
})

// --json: this machine's items as JSON, the peer's half; bare: the dry run, every machine's lines, removing nothing.
if (import.meta.main) {
  const places = livePlaces()
  if (process.argv.includes("--json")) console.log(JSON.stringify(await measureUnused(places)))
  else
    for (const found of await unusedEverywhere(places, mainCheckout(), run)) {
      const { item, total } = linesOf(found, places.home)
      console.log(item ? `${total}\n${item}` : total)
    }
}
