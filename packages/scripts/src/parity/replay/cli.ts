import { cpSync, existsSync, readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { dataDir } from "@packages/env/data-dir"
import { extensionsDir } from "@packages/settings"

import {
  comparators,
  fixtureDir,
  LAYOUTS,
  problems,
  replayOutcome,
  replaysDir,
  runSide,
  skillFile,
  type Replay,
  type Replays,
  type SkillMap,
} from "./run"
import { listTools, type Server } from "./snapshot"

type Entry = { map: SkillMap; name: string; replay: Replay; scope: string; scopeName: string }

// Every replay a scope under the extensions root carries, in its replays folder; core carries none, so a machine with no extension has none.
const entriesIn = async (root: string): Promise<Entry[]> => {
  const entries: Entry[] = []
  const scopes = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    : []
  for (const { name: scopeName } of scopes.sort((a, b) => a.name.localeCompare(b.name))) {
    const scope = join(root, scopeName)
    const file = join(replaysDir(scope), "replays.json")
    if (!existsSync(file)) continue
    const replays = (await Bun.file(file).json()) as Replays
    const mapFile = join(replaysDir(scope), "map.json")
    const map = existsSync(mapFile) ? ((await Bun.file(mapFile).json()) as SkillMap) : {}
    for (const [name, replay] of Object.entries(replays))
      entries.push({ map, name, replay, scope, scopeName })
  }
  return entries
}

// `bun run parity replay [--only <name>] [--runs <n>] [--base <ref>] [--snapshot]`: replays each skill a scope's replays.json names before (its folder at --base in the scope's own git, HEAD by default) and after (the scope's working tree) on its made-up fixtures, and exits 1 on any change, noise or miss. `--runs 0` checks every replay's setup and runs no model; `--snapshot` writes a copy of each scope's layouts with each server's schema from one live tools/list into a scratch folder, for `playground ext put`, since only its verbs write the extensions.
export const replay = async (args: string[]): Promise<number> => {
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const all = await entriesIn(extensionsDir(dataDir()))
  const only = option("--only")
  if (only && !all.some((e) => e.name === only)) {
    console.error(
      `parity replay: no replay named ${only} (${all.map((e) => e.name).join(", ") || "no scope holds a replay"})`,
    )
    return 2
  }
  const entries = only ? all.filter((e) => e.name === only) : all
  if (!entries.length) {
    console.log("parity replay: no scope holds a replay")
    return 0
  }

  if (args.includes("--snapshot")) {
    const servers = (await Bun.file(join(homedir(), ".mcp.json")).json()).mcpServers as Record<
      string,
      Server
    >
    const out = join(tmpdir(), `parity-snapshot-${process.pid}`)
    for (const scopeName of [...new Set(entries.map((e) => e.scopeName))]) {
      const scope = entries.find((e) => e.scopeName === scopeName)!.scope
      const copy = join(out, scopeName)
      if (existsSync(join(scope, LAYOUTS))) cpSync(join(scope, LAYOUTS), copy, { recursive: true })
      const named = entries
        .filter((e) => e.scopeName === scopeName)
        .flatMap((e) => e.replay.servers)
      for (const server of [...new Set(named)].sort()) {
        if (!servers[server]) throw new Error(`parity replay: ~/.mcp.json names no ${server}`)
        const tools = await listTools(servers[server])
        await Bun.write(
          join(copy, "schemas", `${server}.json`),
          `${JSON.stringify(tools, null, 2)}\n`,
        )
        console.log(`parity replay: ${server} lists ${tools.length} tools`)
      }
      console.log(
        `parity replay: put it with playground ext put ${scopeName} script parity-replay ${copy} --reason "<why>"`,
      )
    }
    return 0
  }

  const found = (
    await Promise.all(entries.map((e) => problems(e.scope, e.name, e.replay, e.map)))
  ).flat()
  for (const line of found) console.error(`parity replay: ${line}`)
  if (found.length) return 1
  const runsOption = option("--runs")
  if (runsOption === "0") {
    for (const e of entries)
      console.log(
        `parity replay: ${e.name} ready (${e.scopeName}/${e.map[e.name]!.skill}, ${e.replay.servers.join(", ")})`,
      )
    return 0
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const claude = Bun.which("claude")
  if (!token || !claude) {
    console.error(
      "parity replay: a run needs claude on PATH and CLAUDE_CODE_OAUTH_TOKEN set, in skill-trial's shape (.agents/skill-trial.md)",
    )
    return 2
  }
  const base = option("--base") ?? "HEAD"
  const scratch = join(tmpdir(), `parity-replay-${process.pid}`)
  let failed = false
  for (const e of entries) {
    const skill = e.map[e.name]!.skill
    const before = join(scratch, "before", e.scopeName)
    await Bun.$`mkdir -p ${before} && git -C ${e.scope} archive ${base} skills | tar -x -C ${before}`
    const runs = runsOption ? Number(runsOption) : e.replay.runs
    const comparator = (await comparators(e.scope))[e.replay.compare]!
    const outcome = await replayOutcome(
      e.name,
      (side, n) =>
        runSide({
          claude,
          env: process.env,
          file: skillFile(e.map[e.name]!),
          fixtures: fixtureDir(e.scope, e.name),
          replay: e.replay,
          runs: n,
          scope: e.scope,
          scratch: join(scratch, e.name, side),
          sign: comparator.sign,
          skillDir: join(side === "before" ? before : e.scope, skill),
          token,
        }),
      runs,
      comparator.majority,
    )
    const ok = outcome.outcome === "same" && outcome.misses.length === 0
    failed ||= !ok
    console.log(`parity replay: ${e.name} ${outcome.outcome}, ${outcome.misses.length} misses`)
    for (const miss of outcome.misses) console.log(`  miss ${miss}`)
    if (outcome.outcome !== "same")
      console.log(`  before ${outcome.before}\n  after  ${outcome.after}`)
  }
  console.log(`parity replay: runs kept in ${scratch}`)
  return failed ? 1 : 0
}
