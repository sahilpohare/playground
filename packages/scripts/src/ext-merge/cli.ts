import "@packages/env/aliases"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { dataDir } from "@packages/env/data-dir"

import { guardedRepos } from "../../../../scripts/hooks/no-extension-repo-write"
import { extensionsDir, readPolicy } from "../../../settings/src/rendered"
import { type Agent } from "./gates"
import { extMerge } from "./merge"

const USAGE = `Usage: bun run ext:merge <owner>/<repo> <n> [--explain]

Squash-merges PR <n> of an extension repository into its default branch at its current head,
the one way a session's branch reaches the default there, and refuses unless every gate passed
at that head:

  extension    no-extension-repo-write guards the repository
  open         the PR is open
  author       the signed-in account, which every session pushes as, opened it
  ready        the PR is not a draft
  base         it merges into the repository's default branch
  head         its head is a branch of the same repository
  review       ## ReviewBot · round <n>: 5/5 at <sha7>, at the head, from the signed-in account
  independent  a reviewer session other than the PR's author lists the PR in the roster
  ci           every check at the head finished and passed; a head with none passes only when
               the repository has no workflow file at the head or on the default branch
  mergeable    GitHub reads the PR as merging clean

Options
  --explain    print each gate and what it found at the head, and merge nothing
  -h, --help   this help`

const { positionals, values } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { explain: { type: "boolean" }, help: { short: "h", type: "boolean" } },
    })
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exit(1)
  }
})()
const [repo = "", number = ""] = positionals
const n = Number(number)
if (
  values.help ||
  positionals.length !== 2 ||
  !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
  !Number.isInteger(n) ||
  n <= 0
) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

try {
  const data = dataDir(process.env)
  let repos = new Set<string>()
  if (existsSync(extensionsDir(data))) {
    const read = await readPolicy(data)
    if (read.refusal !== undefined) throw new Error(read.refusal)
    repos = guardedRepos(data, read.settings.values, process.env)
  }
  const roster = (await Bun.file(join(data, "roster.json"))
    .json()
    .catch(() => null)) as { agents?: Agent[] } | null
  const outcome = await extMerge(repo, n, {
    agents: Array.isArray(roster?.agents) ? roster.agents : [],
    explain: values.explain,
    repos,
  })
  for (const gate of outcome.gates)
    console.log(`${gate.ok ? "✓" : "✗"} ${gate.name}  ${gate.detail}`)
  switch (outcome.kind) {
    case "explained":
      process.exit(outcome.gates.every((gate) => gate.ok) ? 0 : 1)
      break
    case "refused": {
      const missing = outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)
      console.error(`Refused: ${repo}#${n} has not passed ${missing.join(", ")} at its head`)
      process.exit(1)
      break
    }
    case "failed":
      console.error(`Not merged: ${outcome.reason}`)
      process.exit(1)
      break
    case "merged":
      console.log(`Merged ${repo}#${n} at ${outcome.sha}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
