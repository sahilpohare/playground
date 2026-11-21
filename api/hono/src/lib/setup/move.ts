import { GuardError, locate } from "@/lib/sessions/guard"
import type { Run } from "@/lib/setup/container"

// The move an install made before the loopback rule needs: its database container publishes on every interface, which the guard refuses, so the container is started again under its own name on 127.0.0.1 alone, on the same host port, with the old one's volumes, image, command, environment, labels and restart policy; the old one is left stopped under <name>-old, never removed, and set to stay stopped, so a Docker restart never starts both on the same data.

export class MoveError extends Error {}

const READY_TRIES = 30

type Json = Record<string, unknown>

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : []

export type Kept = {
  cmd: string[]
  containerPort: string
  env: string[]
  image: string
  labels: [string, string][]
  restart: string
}

// Pure: what the new container keeps from the old one's `docker inspect`, the container port being the one the host port maps to.
export const keptOf = (inspectStdout: string, port: number): Kept => {
  const container = record((JSON.parse(inspectStdout) as unknown[])[0])
  const config = record(container.Config)
  const policy = record(record(container.HostConfig).RestartPolicy)
  const ports = record(record(container.NetworkSettings).Ports)
  const containerPort =
    Object.entries(ports).find(
      ([, bindings]) =>
        Array.isArray(bindings) &&
        bindings.some((binding) => record(binding).HostPort === String(port)),
    )?.[0] ?? "5432/tcp"
  const name = typeof policy.Name === "string" && policy.Name ? policy.Name : "no"
  const retries = Number(policy.MaximumRetryCount) || 0
  return {
    cmd: strings(config.Cmd),
    containerPort: containerPort.replace(/\/tcp$/, ""),
    env: strings(config.Env),
    image: typeof container.Image === "string" ? container.Image : "",
    labels: Object.entries(record(config.Labels))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([a], [b]) => a.localeCompare(b)),
    restart: name === "on-failure" && retries > 0 ? `${name}:${retries}` : name,
  }
}

// Pure: argv that starts the moved container under name, on 127.0.0.1 alone and the same host port, with the volumes of name-old.
export const loopbackArgv = (name: string, port: number, kept: Kept): string[] => [
  "run",
  "-d",
  "--name",
  name,
  "-p",
  `127.0.0.1:${port}:${kept.containerPort}`,
  "--volumes-from",
  `${name}-old`,
  "--restart",
  kept.restart,
  ...kept.env.flatMap((line) => ["-e", line]),
  ...kept.labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
  kept.image,
  ...kept.cmd,
]

// Pure: the one command that removes the old container once the moved one holds the data; its -v leaves every volume the moved one still mounts.
export const removeLine = (name: string): string => `docker rm -v ${name}-old`

const said = (result: { code: number; stderr: string }) =>
  result.stderr.trim().slice(0, 200) || `exit ${result.code}`

// Moves name onto 127.0.0.1:port, healthy before it returns, and returns the lines that say so; a failure puts the old container back as it was, started, and throws why.
export async function moveToLoopback(
  name: string,
  port: number,
  docker: Run,
  wait: (ms: number) => Promise<void> = Bun.sleep,
): Promise<string[]> {
  const old = `${name}-old`
  if ((await docker(["inspect", old])).code === 0) {
    throw new MoveError(`${old} already exists, so ${name} cannot move aside; ${name} is untouched`)
  }
  const inspected = await docker(["inspect", name])
  if (inspected.code !== 0) throw new MoveError(`docker inspect ${name} failed: ${said(inspected)}`)
  const kept = keptOf(inspected.stdout, port)
  const stopped = await docker(["stop", name])
  if (stopped.code !== 0) throw new MoveError(`docker stop ${name} failed: ${said(stopped)}`)
  let renamed = false
  let started = false
  try {
    const step = async (args: string[]) => {
      const result = await docker(args)
      if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${said(result)}`)
    }
    await step(["update", "--restart", "no", name])
    await step(["rename", name, old])
    renamed = true
    started = true
    await step(loopbackArgv(name, port, kept))
    let ready = false
    for (let tries = 0; tries < READY_TRIES && !ready; tries++) {
      if (tries > 0) await wait(1_000)
      ready = (await docker(["exec", name, "pg_isready"])).code === 0
    }
    if (!ready)
      throw new Error(`Postgres in the moved ${name} did not answer in ${READY_TRIES} seconds`)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    const back = [
      ...(started ? [["rm", "-f", name]] : []),
      ...(renamed ? [["rename", old, name]] : []),
      ["update", "--restart", kept.restart, name],
      ["start", name],
    ]
    for (const args of back) {
      const result = await docker(args)
      if (result.code !== 0 && args[0] !== "rm") {
        throw new MoveError(
          `the move failed (${why}), and putting ${name} back failed too: docker ${args[0]} ${said(result)}`,
        )
      }
    }
    throw new MoveError(`the move failed (${why}); ${name} is started again as it was`)
  }
  return [
    `Moved the database ${name} onto 127.0.0.1:${port} alone, keeping its data`,
    `${old} is stopped and kept; once the Dashboard reads its data, remove it with: ${removeLine(name)}`,
  ]
}

// The move for the container the guard names exposed for url, run once: a container already on loopback alone, or one the guard refuses for any other reason, is left alone with no lines.
export async function moveIfExposed(
  url: string,
  docker: Run,
  find: (url: string) => unknown = locate,
  wait?: (ms: number) => Promise<void>,
): Promise<string[]> {
  try {
    find(url)
    return []
  } catch (error) {
    if (!(error instanceof GuardError) || error.failure !== "exposed" || !error.located) return []
    const { owner, target } = error.located
    return moveToLoopback(owner.name, target.port, docker, wait)
  }
}
