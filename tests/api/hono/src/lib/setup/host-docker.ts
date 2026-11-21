// A stand-in for this machine's real docker in the gate's tests: its containers live in the JSON file DOCKER_STATE names, and it answers the calls first run and the box's docker make, label filters ANDed as Docker's own are.
import { randomBytes } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"

export type HostContainer = {
  env: string[]
  id: string
  labels: Record<string, string>
  name: string
  port: number
  state: string
}

const statePath = process.env.DOCKER_STATE!
const read = (): HostContainer[] => JSON.parse(readFileSync(statePath, "utf8"))
const write = (all: HostContainer[]) => writeFileSync(statePath, JSON.stringify(all))

const valuesOf = (args: string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : []))

const render = (format: string, c: HostContainer): string =>
  format
    .replaceAll("{{.Names}}", c.name)
    .replaceAll("{{.State}}", c.state)
    .replaceAll("{{.ID}}", c.id)
    .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key: string) => c.labels[key] ?? "")

const main = (args: string[]): number => {
  appendFileSync(`${statePath}.log`, `${args.join(" ")}\n`)
  const all = read()
  const [sub, ...rest] = args
  const target = rest.filter((a) => !a.startsWith("-")).at(-1) ?? ""
  const found = all.find((c) => c.name === target)
  if (sub === "info") return 0
  if (sub === "ps") {
    const labels = valuesOf(rest, "--filter")
      .filter((f) => f.startsWith("label="))
      .map((f) => f.slice("label=".length).split("="))
    const format = valuesOf(rest, "--format")[0] ?? "{{.Names}}"
    for (const c of all)
      if (labels.every(([k, v]) => k !== undefined && c.labels[k] === v))
        console.log(render(format, c))
    return 0
  }
  if (sub === "run") {
    const name = valuesOf(rest, "--name")[0]!
    const labels = Object.fromEntries(valuesOf(rest, "--label").map((l) => l.split("=")))
    const env = valuesOf(rest, "-e")
    const id = randomBytes(32).toString("hex")
    all.push({ env, id, labels, name, port: 40000 + all.length, state: "running" })
    write(all)
    console.log(id)
    return 0
  }
  const named = all.find((c) => rest.includes(c.name))
  if (!named) {
    console.error(`Error: No such container: ${target}`)
    return 1
  }
  if (sub === "inspect")
    console.log(
      JSON.stringify([{ Config: { Env: named.env, Labels: named.labels }, Id: named.id }]),
    )
  if (sub === "port") console.log(`5432/tcp -> 127.0.0.1:${named.port}`)
  return found || named ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
