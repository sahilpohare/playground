// The gate box's docker: this machine's real docker narrowed to the containers the box made, so a box's first run, or any job it starts, never reaches a container of the machine's own (the live dashboard's database among them). Usage: docker.ts <real docker> <box name> <calls.log> <docker argv...>
import { appendFileSync } from "node:fs"

// The label every container the box starts carries, set to the box's name; a container without it is one the box did not make.
export const BOX_LABEL = "playground-gate-box"

export type Listed = { id: string; label: string; names: string[] }

// The real docker's listing of every container, each with its full id, its names and its box label.
export const LIST_ARGV = [
  "ps",
  "-a",
  "--no-trunc",
  "--format",
  `{{.ID}}\t{{.Names}}\t{{.Label "${BOX_LABEL}"}}`,
]

export const listedOf = (out: string): Listed[] =>
  out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [id = "", names = "", label = ""] = line.split("\t")
      return { id: id.trim(), label: label.trim(), names: names.trim().split(",") }
    })

// The flags a box's docker run takes, each with whether it takes a value: those first run (startArgv) and its move (loopbackArgv) use, so a run mounts no volume or host path and joins no host network.
const RUN_FLAGS = new Map([
  ["--detach", false],
  ["--env", true],
  ["--label", true],
  ["--name", true],
  ["--publish", true],
  ["--restart", true],
  ["--volumes-from", true],
  ["-d", false],
  ["-e", true],
  ["-l", true],
  ["-p", true],
])

// Pure: the first run flag the box's docker refuses, or a publish past 127.0.0.1, up to the image, or null when every flag is first run's own.
export const runRefusal = (rest: string[]): string | null => {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith("-")) return null
    const [flag = "", inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined]
    const takes = RUN_FLAGS.get(flag)
    if (takes === undefined) return arg
    const value = takes ? (inline ?? rest[++i] ?? "") : ""
    if ((flag === "-p" || flag === "--publish") && !value.startsWith("127.0.0.1:"))
      return `${flag} ${value}`
  }
  return null
}

const READS = new Set(["info", "version", "--version", "images", "pull"])
const NAMED = new Set([
  "exec",
  "inspect",
  "kill",
  "logs",
  "port",
  "rename",
  "restart",
  "rm",
  "start",
  "stats",
  "stop",
  "update",
  "wait",
])

// Pure: the argv the box's docker hands the real one, its own answer, or why it refuses: ps, run and a bare stats keep to the box's label, a call naming a container the box did not make is refused, and so is every other subcommand (prune, volume, system, cp), since it reaches past the box's own; a refusal always names a reach, never a read the box's own jobs make.
export const narrow = (
  argv: string[],
  box: string,
  listed: Listed[] | null,
): { argv: string[] } | { answer: string } | { refused: string } => {
  const [sub = "", ...rest] = argv
  const own = `${BOX_LABEL}=${box}`
  if (READS.has(sub)) return { argv }
  if (sub === "context" && ["inspect", "ls", "show"].includes(rest[0] ?? "")) return { argv }
  if (sub === "ps") return { argv: [...argv, "--filter", `label=${own}`] }
  if (sub !== "run" && !NAMED.has(sub))
    return { refused: `${sub || "(none)"}: not a call the box makes` }
  if (listed === null) return { refused: `${sub}: docker could not list its containers` }
  const words = rest.flatMap((a) =>
    a.startsWith("-") ? (a.includes("=") ? [a.slice(a.indexOf("=") + 1)] : []) : [a],
  )
  // docker resolves a word to a container by its name, with or without slashes at either end, or by any unique id prefix, and reads one inside name:ro, container:name and name:alias
  const resolved = (w: string) =>
    w
      .split(":")
      .map((part) => part.replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .flatMap((part) =>
        listed.filter(
          (c) => c.names.includes(part) || (/^[0-9a-f]+$/.test(part) && c.id.startsWith(part)),
        ),
      )
  const other = words.find((w) => resolved(w).some((c) => c.label !== box))
  if (other) return { refused: `${sub} ${other}` }
  const flag = sub === "run" ? runRefusal(rest) : null
  if (flag) return { refused: `run ${flag}` }
  // a bare stats reads every container on the machine, so the box's reads its own alone, and none answers empty
  if (sub === "stats" && !words.some((w) => resolved(w).length)) {
    const mine = listed.filter((c) => c.label === box).flatMap((c) => c.names.slice(0, 1))
    return mine.length ? { argv: [...argv, ...mine] } : { answer: "" }
  }
  return { argv: sub === "run" ? ["run", "--label", own, ...rest] : argv }
}

if (import.meta.main) {
  const [real = "", box = "", log = "", ...argv] = process.argv.slice(2)
  const listing = Bun.spawnSync([real, ...LIST_ARGV], { stderr: "ignore", stdin: "ignore" })
  const decided = narrow(
    argv,
    box,
    listing.exitCode === 0 ? listedOf(listing.stdout.toString()) : null,
  )
  if ("refused" in decided) {
    appendFileSync(log, `docker refused ${decided.refused}\n`)
    console.error(
      `docker: the gate box refuses ${decided.refused}, a container or call this box did not make`,
    )
    process.exit(1)
  }
  appendFileSync(log, `docker ${argv[0] ?? ""}\n`)
  if ("answer" in decided) {
    process.stdout.write(decided.answer)
    process.exit(0)
  }
  const child = Bun.spawn([real, ...decided.argv], {
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  })
  process.exit(await child.exited)
}
