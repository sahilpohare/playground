import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"

import { makeScratch } from "@packages/safe-delete"

import {
  finalText,
  majority,
  triageMajority,
  triageSignature,
  verdict,
  type Verdict,
} from "./compare"
import type { Recording, Tool } from "./stub-mcp"

// The replay runner: one headless claude per run, pointed at a skill's SKILL.md before and after a change, with every MCP server a stub and gh a shim, its reads allowed and every write left callable for dontAsk to refuse, so the refusals show in permission_denials.

export const HERE = import.meta.dir

export type Replay = {
  allowed: string[]
  args: string
  compare: string
  model: string
  runs: number
  servers: string[]
}
export type Replays = Record<string, Replay>
export type SkillMap = Record<string, { file?: string; paths: string[]; skill: string }>

// The file a replay's run reads as its skill, relative to the skill's folder: map.json's file, else SKILL.md.
export const skillFile = (entry: SkillMap[string]): string => entry.file ?? "SKILL.md"

// A scope's replays sit in its own folder, beside the skills they replay: replays/replays.json, replays/map.json (each skill's folder inside the scope) and replays/fixtures/<name>/.
export const replaysDir = (scope: string) => join(scope, "replays")
export const fixtureDir = (scope: string, name: string) => join(replaysDir(scope), "fixtures", name)
// A scope's layouts, its script item parity-replay: schemas/<server>.json, each server's tool list, and compare.ts, the comparators its replays name beyond core's triage.
export const LAYOUTS = join("scripts", "parity-replay")
export const SCHEMAS = join(LAYOUTS, "schemas")
export const schemaFile = (scope: string, server: string) => join(scope, SCHEMAS, `${server}.json`)

// Pure: the --mcp-config naming each server the replay reads as a stub of that name, so its tools keep their mcp__<server>__ names.
export const mcpConfig = (
  scope: string,
  fixtures: string,
  servers: string[],
  misses: string,
): string =>
  JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server,
        {
          args: [
            join(HERE, "stub-mcp.ts"),
            ...["--server", server, "--recording", join(fixtures, `${server}.json`)],
            ...["--schemas", schemaFile(scope, server), "--log", misses],
          ],
          command: process.execPath,
          type: "stdio",
        },
      ]),
    ),
  })

// Pure: the prompt, the skill-trial shape: the branch's skill file read as a file, with its folder standing in for CLAUDE_SKILL_DIR.
export const prompt = (skillDir: string, args: string, file = "SKILL.md"): string =>
  `Read ${join(skillDir, file)} and follow it as the skill it describes, reading \${CLAUDE_SKILL_DIR} as ${skillDir}. Its arguments: ${args || "none"}. Each Bash call runs one plain command, with no ;, &&, ||, pipe or redirect, since a compound command is refused whole here.`

// Pure: the headless argv; the prompt comes before --allowedTools, which takes every argument after it as a tool, and no --disallowedTools, so a refused write stays callable and shows as a denial.
export const replayArgv = (o: {
  allowed: string[]
  claude: string
  mcp: string
  model: string
  prompt: string
  skillDir: string
}) => [
  o.claude,
  "-p",
  o.prompt,
  ...["--model", o.model, "--output-format", "stream-json", "--verbose"],
  ...["--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", o.mcp],
  "--allowedTools",
  ...o.allowed.map((tool) => tool.replaceAll("${CLAUDE_SKILL_DIR}", o.skillDir)),
]

// Pure: the run's environment: a sandboxed HOME, the shim first on PATH, the account's token, and nothing that could move it off Claude or onto this session's terminal.
export const replayEnv = (
  env: Record<string, string | undefined>,
  o: { fixtures: string; home: string; misses: string; token: string },
): Record<string, string> => {
  const kept = Object.entries(env).filter(
    ([k, v]) =>
      v !== undefined &&
      !k.startsWith("ANTHROPIC_") &&
      !/^(CLAUDE_CODE_|CMUX_)/.test(k) &&
      !["CLAUDECODE", "CLAUDE_CONFIG_DIR"].includes(k),
  ) as [string, string][]
  return {
    ...Object.fromEntries(kept),
    CLAUDE_CODE_OAUTH_TOKEN: o.token,
    HOME: o.home,
    PARITY_GH: join(o.fixtures, "gh.json"),
    PARITY_MISSES: o.misses,
    PATH: `${join(HERE, "bin")}:${env.PATH ?? ""}`,
  }
}

// How a replay compares its runs: each run's signature, and how a side's signatures make its majority.
export type Comparator = {
  majority: (signatures: string[]) => string | null
  sign: (lines: string[]) => string
}

// The comparators a scope's replays can name: core's triage, which takes each item most runs share, and each one the scope's compare.ts exports in `comparators`, which signs the run's last message and takes the one exact signature most runs share.
export const comparators = async (scope: string): Promise<Record<string, Comparator>> => {
  const file = join(scope, LAYOUTS, "compare.ts")
  const own = existsSync(file)
    ? (((await import(file)).comparators ?? {}) as Record<string, (report: string) => string>)
    : {}
  return {
    ...Object.fromEntries(
      Object.entries(own).map(([name, sign]) => [
        name,
        { majority, sign: (lines: string[]) => sign(finalText(lines)) },
      ]),
    ),
    triage: { majority: triageMajority, sign: triageSignature },
  }
}

// Every problem in a replay's setup, found without running a model: its skill in its scope's map.json and on disk there, a recording and a schema for each server, every recorded tool in its server's schema, gh's recording, and its comparator.
export const problems = async (
  scope: string,
  name: string,
  replay: Replay,
  map: SkillMap,
): Promise<string[]> => {
  const found: string[] = []
  const entry = map[name]
  if (!entry) return [`${name}: not in map.json`]
  if (!(await Bun.file(join(scope, entry.skill, skillFile(entry))).exists()))
    found.push(`${name}: no ${join(entry.skill, skillFile(entry))}`)
  for (const server of replay.servers) {
    const schema = Bun.file(schemaFile(scope, server))
    const recording = Bun.file(join(fixtureDir(scope, name), `${server}.json`))
    if (!(await schema.exists()))
      found.push(
        `${name}: no layout for ${server}: the scope holds no ${join(SCHEMAS, `${server}.json`)}`,
      )
    if (!(await recording.exists())) found.push(`${name}: no recording for ${server}`)
    if (!(await schema.exists()) || !(await recording.exists())) continue
    const tools = new Set(((await schema.json()) as Tool[]).map((t) => t.name))
    for (const tool of Object.keys((await recording.json()) as Recording))
      if (!tools.has(tool))
        found.push(`${name}: ${server}'s recording answers ${tool}, which its schema lacks`)
  }
  const gh = Bun.file(join(fixtureDir(scope, name), "gh.json"))
  if (!(await gh.exists()) || !Array.isArray(await gh.json()))
    found.push(`${name}: no gh.json list`)
  if (!(replay.compare in (await comparators(scope))))
    found.push(
      `${name}: no comparator ${replay.compare}: core has triage, and the scope's ${join(LAYOUTS, "compare.ts")} names no ${replay.compare}`,
    )
  return found
}

export type Side = { misses: string[]; signatures: string[] }

// Every skill beside the replay's own in its scope, on the side it runs, linked into the sandbox's ~/.claude/skills, so a path a skill names there (~/.claude/skills/<sibling>/scripts/<file>) resolves.
export const linkSkills = (home: string, skillDir: string) => {
  const root = dirname(skillDir)
  const skills = join(home, ".claude", "skills")
  mkdirSync(skills, { recursive: true })
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) symlinkSync(join(root, entry.name), join(skills, entry.name))
}

// One side's runs, each in its own sandboxed HOME in a fresh scratch folder (run-<i>-<random>), so a side rerun at 5 reuses no earlier run's folder; a miss in any run is kept, so the replay fails on a read the recording lacks.
export const runSide = async (o: {
  claude: string
  env: Record<string, string | undefined>
  file: string
  fixtures: string
  replay: Replay
  runs: number
  scope: string
  scratch: string
  sign: Comparator["sign"]
  skillDir: string
  token: string
}): Promise<Side> => {
  const side: Side = { misses: [], signatures: [] }
  for (let i = 0; i < o.runs; i++) {
    mkdirSync(o.scratch, { recursive: true })
    const dir = makeScratch(`run-${i}-`, o.scratch)
    const misses = join(dir, "misses.jsonl")
    await Bun.write(misses, "")
    await Bun.write(join(dir, "home", ".keep"), "")
    linkSkills(join(dir, "home"), o.skillDir)
    const argv = replayArgv({
      allowed: o.replay.allowed,
      claude: o.claude,
      mcp: mcpConfig(o.scope, o.fixtures, o.replay.servers, misses),
      model: o.replay.model,
      prompt: prompt(o.skillDir, o.replay.args, o.file),
      skillDir: o.skillDir,
    })
    const run = Bun.spawn(argv, {
      cwd: join(dir, "home"),
      env: replayEnv(o.env, {
        fixtures: o.fixtures,
        home: join(dir, "home"),
        misses,
        token: o.token,
      }),
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    })
    const out = await new Response(run.stdout).text()
    await run.exited
    await Bun.write(join(dir, "stream.jsonl"), out)
    side.signatures.push(o.sign(out.split("\n")))
    side.misses.push(...(await Bun.file(misses).text()).split("\n").filter(Boolean))
  }
  return side
}

export type Outcome = Verdict & { misses: string[]; name: string }

// The replay's verdict: the before side reruns at 5 when it has no majority, and any miss fails it whatever the signatures say.
export const replayOutcome = async (
  name: string,
  run: (side: "after" | "before", runs: number) => Promise<Side>,
  runs: number,
  majorityOf: (signatures: string[]) => string | null = majority,
): Promise<Outcome> => {
  let before = await run("before", runs)
  if (verdict(before.signatures, before.signatures, majorityOf).outcome === "noisy")
    before = await run("before", 5)
  const after = await run("after", runs)
  return {
    ...verdict(before.signatures, after.signatures, majorityOf),
    misses: [...before.misses, ...after.misses],
    name,
  }
}
