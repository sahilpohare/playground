import { parseMetrics, speedOf } from "./speed"
import {
  type MachineState,
  type ModelServer,
  PORTS,
  machineState,
  statePath,
  writeMachineState,
} from "./state"

// playground model use <name>: a local model server on one machine, this one or the peer, sized from that machine's free memory as it starts. Its share is what is free above the machine's reserve, capped at the model's working share, and its --max-num-seqs the KV cache that share leaves at 64k tokens a session. It starts beside a running model when the reading fits both, each under its own container name and port, and swaps otherwise: hold, drain, stop by name, size again, start. Every step is one fixed command, over ssh on the peer.

export type Ran = { code: number; out: string }
// A machine the servers run on: the peer is reached at target over ssh; this machine has none.
export type Machine = { name: string; target?: string }

// One line of the machine record, its Entry, written on this machine or on the peer.
export type RecordEntry = {
  added: string
  by: string
  kind: "container" | "file" | "folder" | "image" | "link"
  path: string
  undo: string
  why: string
}

export type Figures = {
  cap: number
  kvKiBPerToken: number
  overheadGiB: number
  weightsGiB: number
}

export type ModelConfig = {
  container: string
  drainMinutes: number
  idleMinutes: number
  // the model this machine keeps up, "" for none
  keep: string
  minFreeGiB: number
  models: Record<string, Figures>
  // what a server leaves free on its machine: localModels.hereReserveGiB here, the floor and the box-run reserve on the peer
  reserveGiB: number
  sessionTokens: number
}

export type ModelDeps = {
  config: ModelConfig
  data: string
  key?: string
  machine: Machine
  now: () => Date
  // the machine record's add; a failed write is said and never fails the start
  record: (entries: RecordEntry[], where: "here" | "peer") => Promise<void>
  run: (argv: string[], timeoutMs?: number) => Promise<Ran>
  say: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

// started: whether this call started a server, so the keep beat stays quiet on one already serving
export type Result = { code: number; line: string; started?: boolean }

// What the issue fixes: each container's name before its model's folder, the longest wait for a swap's drain, the free memory a load never takes a machine under, and a session's KV cache in tokens.
export const FIXED = {
  container: "local-vllm",
  drainMinutes: 30,
  minFreeGiB: 15,
  sessionTokens: 65536,
}

// A model's folder under ~/models: a letter or digit first, then lowercase, digits, dots and dashes, so it can name no path or flag.
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]*$/
// The four values a start hands serve.sh, which takes each from its environment over its own default; in the order serve.sh's docker run line reads them.
export const SERVE_ENV = ["CONTAINER", "PORT", "GPU_MEMORY_UTILIZATION", "MAX_NUM_SEQS"] as const
const POLL_MS = 5_000
// how long a stopped server's memory has to come back before a start is refused
const FREE_WAIT_MS = 2 * 60_000
// how long a started server has to answer /health
const LOAD_MS = 15 * 60_000
const KIB_PER_GIB = 1024 * 1024

// Pure: the argv that runs one fixed command on machine: on the peer ssh, the key alone, no prompt, a 10 s connect, -F none keeping the user's own ssh config out of it; here sh.
export const commandArgv = (
  machine: Machine,
  key: string | undefined,
  command: string,
): string[] =>
  machine.target
    ? [
        "ssh",
        "-F",
        "none",
        ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        machine.target,
        command,
      ]
    : ["sh", "-c", command]

export type Memory = { available: number; total: number }

// Pure: MemAvailable and MemTotal in GiB from /proc/meminfo, or null when either is missing.
export const memOf = (text: string): Memory | null => {
  const kb = (name: string) => {
    const found = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text)
    return found ? Number(found[1]) / KIB_PER_GIB : null
  }
  const available = kb("MemAvailable")
  const total = kb("MemTotal")
  return available === null || total === null ? null : { available, total }
}

// Pure: vLLM's requests running and waiting, summed from /metrics, or null when neither is there.
export const busyOf = (text: string): number | null => {
  const counts = [
    ...text.matchAll(/^vllm:num_requests_(?:running|waiting)(?:\{[^}]*\})? ([0-9.]+)$/gm),
  ]
  return counts.length ? counts.reduce((sum, found) => sum + Number(found[1]), 0) : null
}

// Pure: whether a /metrics read shows the model working, its requests running and waiting above 0; a read that failed or names neither is not busy.
export const metricsBusy = (text: string | null): boolean => {
  const busy = text === null ? null : busyOf(text)
  return busy !== null && busy > 0
}

export type Sizing = { maxSessions: number; roomGiB: number; share: number }

// Pure: a server's share and sessions from one memory reading: the room is what is free above the reserve, the share that room over the total, rounded down to a hundredth and capped at the model's working share, and the sessions the KV cache that share leaves after weights and overhead, at sessionTokens each.
export const sizeOf = (
  memory: Memory,
  figures: Figures,
  { reserveGiB, sessionTokens }: Pick<ModelConfig, "reserveGiB" | "sessionTokens">,
): Sizing => {
  const roomGiB = memory.available - reserveGiB
  const share = Math.max(0, Math.min(figures.cap, Math.floor((roomGiB / memory.total) * 100) / 100))
  const kvGiB = share * memory.total - figures.weightsGiB - figures.overheadGiB
  const maxSessions =
    kvGiB > 0 ? Math.floor((kvGiB * KIB_PER_GIB) / (sessionTokens * figures.kvKiBPerToken)) : 0
  return { maxSessions, roomGiB, share }
}

const gib = (value: number) => `${Math.round(value * 10) / 10} GiB`
const refuse = (line: string): Result => ({ code: 1, line })

// Pure: whether a server read back from the state file has the container name and port a start gives, since readModelState only casts its JSON and both reach a shell.
const sendable = (server: { container: unknown; port: unknown }) =>
  typeof server.container === "string" &&
  MODEL_NAME.test(server.container) &&
  PORTS.some((port) => port === server.port)

// The fixed commands, each built from names MODEL_NAME passed, a port from PORTS and numbers.
const commands = {
  health: (port: number) =>
    `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health`,
  inspect: (container: string) => `docker inspect --format '{{.State.Running}}' ${container}`,
  memory: "cat /proc/meminfo",
  metrics: (port: number) => `curl -sf --max-time 5 http://127.0.0.1:${port}/metrics`,
  serve: (name: string, container: string, port: number, size: Sizing) =>
    `CONTAINER=${container} PORT=${port} GPU_MEMORY_UTILIZATION=${size.share} MAX_NUM_SEQS=${size.maxSessions} ~/models/${name}/serve.sh`,
  // whether the serve.sh is there, then which of SERVE_ENV it takes from its environment, as ${NAME:-default}
  serves: (name: string) =>
    `test -f ~/models/${name}/serve.sh && echo found && grep -o -E '[$][{](${SERVE_ENV.join("|")}):-' ~/models/${name}/serve.sh`,
  stop: (container: string) => `docker rm -fv ${container}`,
}

// Pure: the machine's hold while a swap may still be running; one older than twice the longest swap is what a killed run left behind, and holds nothing.
const liveHold = (state: MachineState, { config, now }: Pick<ModelDeps, "config" | "now">) =>
  state.hold &&
  now().getTime() - Date.parse(state.hold.since) <
    (config.drainMinutes * 60_000 + FREE_WAIT_MS + LOAD_MS) * 2
    ? state.hold
    : null

const lastLine = (out: string) => out.trim().split("\n").at(-1)?.slice(0, 300) || "no output"

// Starts name's server on deps.machine, beside what runs there when the reading fits both and in place of it otherwise, or refuses saying why and what is left running; a swap's hold is lifted on every path.
export async function useModel(name: string, deps: ModelDeps): Promise<Result> {
  if (!MODEL_NAME.test(name))
    return refuse(`${name || "''"} is not a model folder name under ~/models, so nothing changed`)
  const { config, data, now, say, sleep } = deps
  const figures = config.models[name]
  if (!figures)
    return refuse(
      `localModels.models has no sizing figures for ${name}, so nothing changed: add its cap, weightsGiB, overheadGiB and kvKiBPerToken`,
    )
  const machine = deps.machine.name
  const run = (command: string, timeoutMs = 30_000) =>
    deps.run(commandArgv(deps.machine, deps.key, command), timeoutMs)
  const serves = await run(commands.serves(name))
  if (deps.machine.target && serves.code === 255)
    return refuse(
      `${machine} did not answer over ssh (${lastLine(serves.out)}), so nothing changed`,
    )
  if (!serves.out.startsWith("found"))
    return refuse(`${machine} has no ~/models/${name}/serve.sh, so nothing changed`)
  const taken = new Set(serves.out.match(/[A-Z_]+(?=:-)/g) ?? [])
  const missing = SERVE_ENV.filter((env) => !taken.has(env))
  if (missing.length)
    return refuse(
      `~/models/${name}/serve.sh on ${machine} does not take ${missing.join(", ")} from its environment, so it cannot be sized and nothing changed`,
    )
  let state = await machineState(data, machine)
  const save = async (part: MachineState) => {
    state = part
    await writeMachineState(data, machine, state)
  }
  if (state.hold) {
    if (liveHold(state, deps))
      return refuse(
        `a swap to ${state.hold.for} has run on ${machine} since ${state.hold.since}, so nothing changed`,
      )
    const { hold: _, ...rest } = state
    await save(rest)
  }
  const servers = () => state.servers ?? {}
  const without = (model: string) => {
    const { [model]: _, ...rest } = servers()
    return rest
  }
  // stops a server by the exact name it was started under, a name of MODEL_NAME's shape alone, since the state file is read back; true once no container has that name
  const stopOwn = async (container: string) =>
    MODEL_NAME.test(container) &&
    ((await run(commands.stop(container))).code === 0 ||
      (await run(commands.inspect(container))).code !== 0)
  const unstopped = (container: string) =>
    refuse(`docker rm -fv ${container} failed on ${machine}, so nothing started`)
  const container = `${config.container}-${name}`
  const mine = servers()[name]
  const inspected = await run(commands.inspect(container))
  if (inspected.code === 0 && !mine)
    return refuse(
      `${container} on ${machine} was not started by playground model use, so it is left as it is: stop it by hand, then run playground model use ${name}`,
    )
  if (mine && inspected.code === 0 && inspected.out.trim() === "true")
    return { code: 0, line: `${name} already serves on ${machine} at 127.0.0.1:${mine.port}` }
  if (mine) {
    // started by this command and since stopped: its name is freed before the new start
    if (!(await stopOwn(container))) return unstopped(container)
    await save({ ...state, servers: without(name) })
  }
  const readMemory = async () => memOf((await run(commands.memory)).out)
  const unread = () => refuse(`/proc/meminfo on ${machine} did not read, so nothing started`)
  let memory = await readMemory()
  if (!memory) return unread()
  let size = sizeOf(memory, figures, config)
  const others = Object.entries(servers())
  const freePort = () =>
    PORTS.find((port) => !Object.values(servers()).some((server) => server.port === port))
  const beside = size.maxSessions >= 1 && freePort() !== undefined
  let held: MachineState["hold"]
  try {
    if (!beside) {
      if (others.length) {
        // each container name and port the swap sends is read back from the state file, so each is checked once, before any is sent
        const odd = others.find(([, server]) => !sendable(server))
        if (odd)
          return refuse(
            `the state file's entry for ${odd[0]} on ${machine} (container ${odd[1].container}, port ${odd[1].port}) is not one playground model use starts, so nothing changed: fix or remove it in ${statePath(data)}`,
          )
        held = { for: name, since: now().toISOString() }
        await save({ ...state, hold: held })
        say(
          `${others.map(([model]) => model).join(" and ")} cannot run beside ${name} on ${machine}; holding new starts there and waiting for their requests`,
        )
        const drainBy = now().getTime() + config.drainMinutes * 60_000
        for (const [model, server] of others) {
          for (;;) {
            const busy = busyOf((await run(commands.metrics(server.port))).out)
            // a /metrics that does not read is waited on while the container runs, since it can be a server too busy to answer
            if (busy === 0) break
            if (
              busy === null &&
              (await run(commands.inspect(server.container))).out.trim() !== "true"
            )
              break
            const doing =
              busy === null
                ? "does not answer /metrics while it runs"
                : `has ${busy} requests running or waiting`
            if (now().getTime() >= drainBy)
              return refuse(
                `${model} still ${doing} after ${config.drainMinutes} minutes, so it keeps serving`,
              )
            say(`${model} ${doing}; ${name} waits for it`)
            await sleep(POLL_MS)
          }
        }
        for (const [model, server] of others) {
          if (!(await stopOwn(server.container))) return unstopped(server.container)
          await save({ ...state, servers: without(model) })
        }
      }
      const freeBy = now().getTime() + FREE_WAIT_MS
      for (;;) {
        memory = await readMemory()
        if (!memory) return unread()
        size = sizeOf(memory, figures, config)
        if (size.maxSessions >= 1) break
        if (now().getTime() >= freeBy)
          return refuse(
            `${machine} has ${gib(memory.available)} free; above its ${gib(config.reserveGiB)} reserve that leaves ${gib(Math.max(0, size.roomGiB))}, a share of ${size.share}, which holds no ${config.sessionTokens}-token session of ${name}, so nothing started`,
          )
        await sleep(POLL_MS)
      }
    }
    const port = freePort()!
    const served = await run(commands.serve(name, container, port, size), 10 * 60_000)
    if (served.code !== 0)
      return refuse(`~/models/${name}/serve.sh failed on ${machine}: ${lastLine(served.out)}`)
    if ((await run(commands.inspect(container))).code !== 0)
      return refuse(
        `~/models/${name}/serve.sh ran on ${machine} but started no ${container}, so it did not take CONTAINER from its environment: stop what it started by hand`,
      )
    const at = now().toISOString()
    const server: ModelServer = {
      busyAt: at,
      container,
      maxSessions: size.maxSessions,
      port,
      share: size.share,
      startedAt: at,
    }
    await save({ ...state, servers: { ...servers(), [name]: server } })
    await recordPaths(deps, container, at)
    const loadBy = now().getTime() + LOAD_MS
    for (;;) {
      const reading = await readMemory()
      if (reading && reading.available < config.minFreeGiB) {
        await stopOwn(container)
        await save({ ...state, servers: without(name) })
        return refuse(
          `free memory on ${machine} fell to ${gib(reading.available)} while ${name} loaded, under ${config.minFreeGiB} GiB, so playground model use stopped ${container}`,
        )
      }
      if ((await run(commands.health(port))).out.trim() === "200")
        return {
          code: 0,
          line: `${name} serves on ${machine} at 127.0.0.1:${port}, share ${size.share}, up to ${size.maxSessions} sessions${beside && others.length ? `, beside ${others.map(([model]) => model).join(" and ")}` : ""}${reading ? `, with ${gib(reading.available)} free` : ""}`,
          started: true,
        }
      if (now().getTime() >= loadBy)
        return refuse(
          `${name} did not answer /health on ${machine} in ${LOAD_MS / 60_000} minutes; it is left running as ${container}`,
        )
      await sleep(POLL_MS)
    }
  } finally {
    // lifts only the hold this call set, so another run's stands
    const { hold, ...rest } = await machineState(data, machine)
    if (held && hold?.for === held.for && hold.since === held.since)
      await writeMachineState(data, machine, rest)
  }
}

// The paths a start adds, each in the machine record of the machine it is on; a failed write is said and the start goes on.
const recordPaths = async (
  { data, machine, record, say }: ModelDeps,
  container: string,
  added: string,
) => {
  const by = "playground model use"
  const writes: [RecordEntry, "here" | "peer"][] = [
    [
      {
        added,
        by,
        kind: "container",
        path: `docker container ${container}`,
        undo: `docker rm -fv ${container}`,
        why: "a local model server playground model use started",
      },
      machine.target ? "peer" : "here",
    ],
    [
      {
        added,
        by,
        kind: "file",
        path: statePath(data),
        undo: `remove ${statePath(data)}`,
        why: "the local model servers playground model use started, by machine, and a swap's hold",
      },
      "here",
    ],
  ]
  for (const [entry, where] of writes)
    await record([entry], where).catch((error: unknown) =>
      say(
        `the machine record did not take ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
}

// The keep beat, once per machine: each server's /metrics snapshot and speed are kept for the local gate; a server other than the kept model's with no request for idleMinutes is stopped by its own name, a busy read, or a silent one while its container runs, stamping busyAt, then the kept model is started when it is not serving and no other model asked for is left there; an entry no start would give is skipped, never asked for, and named to ops once. Null when it did nothing new, else the one line for ops; a refusal or skip the last beat already said stays quiet. With a swap's hold set it does nothing.
export async function keepUp(deps: ModelDeps): Promise<string | null> {
  const { config, data, now } = deps
  const machine = deps.machine.name
  const state = await machineState(data, machine)
  if (liveHold(state, deps)) return null
  const run = (command: string) => deps.run(commandArgv(deps.machine, deps.key, command))
  const servers = { ...state.servers }
  const stopped: string[] = []
  // an entry whose name or port no start gives is never sent to a shell nor counted as asked for; ops hears of each once
  const skipped: Record<string, string> = {}
  for (const [model, server] of Object.entries(servers))
    if (!sendable(server))
      skipped[model] =
        `the state file's entry for ${model} on ${machine} (container ${server.container}, port ${server.port}) is not one playground model use starts, so the keep beat skips it: fix or remove it in ${statePath(data)}`
  for (const [model, server] of Object.entries(servers)) {
    if (skipped[model]) continue
    const text = (await run(commands.metrics(server.port))).out
    const snapshot = parseMetrics(text, now().toISOString())
    // a /metrics that does not read leaves no snapshot and no speed, which the local gate reads as a window with no samples
    const { metrics: _metrics, speed: _speed, ...kept } = server
    const read = snapshot
      ? { ...kept, metrics: snapshot, speed: speedOf(server.metrics, snapshot) }
      : kept
    servers[model] = read
    if (model === config.keep || config.idleMinutes === 0) continue
    const busy = busyOf(text)
    // a /metrics that does not read is no idle time while the container runs, as a swap's drain reads it, since it can be a server too busy to answer
    if (
      busy ||
      (busy === null && (await run(commands.inspect(server.container))).out.trim() === "true")
    ) {
      servers[model] = { ...read, busyAt: now().toISOString() }
      continue
    }
    const since = Date.parse(server.busyAt)
    if (Number.isFinite(since) && now().getTime() - since < config.idleMinutes * 60_000) continue
    if ((await run(commands.stop(server.container))).code !== 0) continue
    delete servers[model]
    stopped.push(model)
  }
  const { skipped: told, ...rest } = state
  await writeMachineState(data, machine, {
    ...rest,
    servers,
    ...(Object.keys(skipped).length ? { skipped } : {}),
  })
  const lines = [
    ...Object.entries(skipped)
      .filter(([model, line]) => told?.[model] !== line)
      .map(([, line]) => line),
    ...(stopped.length
      ? [
          `${stopped.join(" and ")} sat idle ${config.idleMinutes} minutes on ${machine}, so playground model use stopped ${stopped.length > 1 ? "them" : "it"}`,
        ]
      : []),
  ]
  // another model still serving here was asked for and is busy, so the kept one waits for its idle stop
  const asked = Object.keys(servers).some((model) => model !== config.keep && !skipped[model])
  if (config.keep && (servers[config.keep] || !asked)) {
    const kept = await useModel(config.keep, deps)
    const { refused, ...after } = await machineState(data, machine)
    if (kept.code === 0) {
      if (kept.started) lines.push(kept.line)
      if (refused) await writeMachineState(data, machine, after)
    } else if (kept.line !== refused) {
      lines.push(kept.line)
      await writeMachineState(data, machine, { ...after, refused: kept.line })
    }
  }
  return lines.length ? lines.join("; ") : null
}
