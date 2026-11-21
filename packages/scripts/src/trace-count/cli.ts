import { join } from "node:path"
import { parseArgs } from "node:util"

import { dataDir } from "../../../env/src/data-dir"
import { ownerSettings } from "../../../settings/src/owner"
import { readPolicy } from "../../../settings/src/rendered"
import {
  COUNTS,
  type Counts,
  changedFiles,
  count,
  KEPT,
  type Kept,
  list,
  listGate,
  listSince,
  located,
  lowered,
  refusal,
  risen,
  risenKinds,
  tree,
} from "./count"
import { publicListPath, reposOf } from "./kinds"
import { inScope, swapTree } from "./swap"

const USAGE = `Usage: bun run trace-count [--write | --report | --swap | --lists [--since <base> [--branch <name>]]]

Counts each kind of private trace, and each Mac-only call with no Linux branch in
front of it (macOnly), over the tree and fails when any count is over
packages/scripts/src/trace-count/counts.json, less each hit kept.json keeps on purpose.
--write lowers each count to the tree's.
--report lists each file holding a list value, with its hits per kind and "swap" on the
files the swap pass covers, and changes nothing. --swap gives each list value in those
files (tests, the API's fixtures, the replay fixtures) a made-up stand-in.
--lists counts the list kinds alone, as each commit's step does: with no list on this
machine it counts nothing, and it reads no settings, so it never exits 2.
With --since, as CI's list step runs it, it reads what the branch adds since its
merge-base with <base> instead (each changed file, a new file's path, each commit message,
and the --branch name), and names each hit by place and kind, never the term.
Exits 2 when no-public-leak's list is missing or a key of it is empty, or when
factory.archiveRepo or owner.names is unset, since their kinds would count nothing.`

const NOT_COUNTED = `trace-count: nothing was counted; bun run test:file tests/packages/scripts/src/trace-count/count.test.ts counts the kinds that need no list or settings, ownerName's quote patterns among them, and the list kinds, the owner's names and the archive's links count only here, once the line above is fixed`

const { values } = parseArgs({
  options: {
    help: { short: "h", type: "boolean" },
    branch: { type: "string" },
    lists: { type: "boolean" },
    report: { type: "boolean" },
    since: { type: "string" },
    swap: { type: "boolean" },
    write: { type: "boolean" },
  },
})
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

const root = join(import.meta.dir, "..", "..", "..", "..")
if (values.lists) {
  const refused = values.since
    ? await listSince(root, values.since, publicListPath(), values.branch)
    : await listGate(root, publicListPath())
  if (refused) console.error(refused)
  process.exit(refused ? 1 : 0)
}
const policy = await readPolicy(dataDir())
if (policy.refusal !== undefined) {
  console.error(`trace-count: ${policy.refusal}`)
  console.error(NOT_COUNTED)
  process.exit(2)
}
const LIST_KINDS = new Set(["companies", "handles", "linearKeys", "names", "slackIds"])
const hits = (counts: Counts) =>
  Object.entries(counts)
    .filter(([kind, n]) => LIST_KINDS.has(kind) && n)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ")
const files = await tree(root)
const read = await list(publicListPath())
if ("refusal" in read) {
  console.error(`trace-count: ${read.refusal}`)
  console.error(NOT_COUNTED)
  process.exit(2)
}
const publicList = read.list
const repos = reposOf(policy.settings)
const unset = [
  ...(repos.archive ? [] : ["factory.archiveRepo"]),
  ...(ownerSettings.get(policy.settings, "owner.names").length ? [] : ["owner.names"]),
]
if (unset.length) {
  console.error(
    `trace-count: ${unset.join(" and ")} ${unset.length > 1 ? "are" : "is"} unset, so ownerName and archiveLinks would miss the owner's names and the archive's links: tell your lead, and the dispatcher asks the owner to fill in Privacy on the Dashboard's Settings page, which sets ${unset.length > 1 ? "them" : "it"}`,
  )
  console.error(NOT_COUNTED)
  process.exit(2)
}
if (values.report) {
  for (const file of files) {
    const found = hits(count([file], publicList, repos))
    if (found) console.log(`${file.path}\t${found}${inScope(file.path) ? "\tswap" : ""}`)
  }
  process.exit(0)
}
if (values.swap) {
  for (const swapped of swapTree(files, publicList, repos)) {
    await Bun.write(join(root, swapped.path), swapped.text)
    console.log(`${swapped.path}\t${hits(swapped.counts)}`)
  }
  process.exit(0)
}
const kept = (await Bun.file(KEPT).json()) as Kept[]
const now = count(files, publicList, repos, kept)
const baseline = (await Bun.file(COUNTS).json()) as Counts
const over = risen(now, baseline)
for (const [kind, n] of Object.entries(now))
  console.log(`${kind}\t${n}\t${baseline[kind as keyof Counts] ?? "-"}`)
if (over.length > 0 && !values.write) {
  console.error(
    refusal(over, located(files, risenKinds(over), publicList, repos, kept, changedFiles(root))),
  )
  process.exit(1)
}
if (values.write) {
  if (over.some((line) => !line.includes("no count yet"))) {
    console.error(`trace-count: --write only lowers a count:\n${over.join("\n")}`)
    process.exit(1)
  }
  await Bun.write(COUNTS, `${JSON.stringify(lowered(now, baseline), null, 2)}\n`)
}
