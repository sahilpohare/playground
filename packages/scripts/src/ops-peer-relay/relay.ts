import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { orgOf, type Peer } from "@packages/config/org"

import { beat } from "../ops-tick/tick"
import { KEY, whyOf } from "../ops-tunnel/tunnel"
import { PEER_QUEUE, type PeerLine } from "../playground/send"
import { writeAtomic } from "../write-atomic"
import { linesOf } from "./agent"
import { HELLO, appendOnce, isPeerLine, linesFrom, parsed } from "./queue"

// ops-peer-relay: copies the outbox's ops-peer.jsonl between this machine and each peer PLAYGROUND_PEERS names, both ways, over one ssh each on the factory's key, so a session on one machine reads a `playground send` from the other in its alerts-wait. The far end is agent.ts, run from the far machine's own checkout; no job runs there.
export const JOB = "ops-peer-relay"

// Pure: PLAYGROUND_PEERS and PLAYGROUND_PEER_KEY from a .env's text, the two keys alone, so the job reads the peers the System page reads with no other value of that file in its env.
export const envKeysOf = (text: string): Record<string, string> => {
  const keys: Record<string, string> = {}
  for (const row of text.split("\n")) {
    const found = /^\s*(?:export\s+)?(PLAYGROUND_PEERS|PLAYGROUND_PEER_KEY)\s*=\s*(.*?)\s*$/.exec(
      row,
    )
    if (found) keys[found[1]!] = found[2]!.replace(/^(["'])(.*)\1$/, "$2")
  }
  return keys
}

// Pure: the peers and the key from those keys, through the organisation's config, the key falling back to the factory's; a value its schema refuses is the why.
export const clusterOf = (
  keys: Record<string, string>,
  home: string,
): { key: string; peers: Peer[] } | { why: string } => {
  try {
    const { cluster } = orgOf(keys)
    return { key: cluster.key ?? join(home, KEY.slice(2)), peers: cluster.peers }
  } catch (error) {
    return {
      why: `PLAYGROUND_PEERS or PLAYGROUND_PEER_KEY does not read: ${(error as Error).message.slice(0, 200)}`,
    }
  }
}

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

// Pure: ssh's argv: the key alone and no prompt, and agent.ts run from the far machine's checkout at the same path as this one's, as spawn.sh --ssh runs there; -F none keeps the user's own ssh config out of it.
export const sshArgs = (
  key: string,
  target: string,
  checkout: string,
  from: number | "end",
): string[] => [
  "-F",
  "none",
  "-i",
  key,
  ...["BatchMode=yes", "ConnectTimeout=10", "IdentitiesOnly=yes"]
    .concat(["ServerAliveCountMax=3", "ServerAliveInterval=15"])
    .flatMap((option) => ["-o", option]),
  target,
  `cd ${quoted(checkout)} && PATH="$HOME/.bun/bin:$PATH" exec bun --no-env-file packages/scripts/src/ops-peer-relay/agent.ts ${from}`,
]

// Why a far end that never said hello ended: a checkout with no agent.ts, or one that cannot run it, reads as the version it lacks.
export const LACKS = `peer checkout lacks agent.ts v${HELLO.version}`
const lacking = (stderr: string) =>
  /Module not found|No such file or directory|Cannot find module|bun: (command )?not found/.test(
    stderr,
  )

// The byte offsets this machine has copied up to: local, its own queue sent to the peer; remote, the peer's queue copied here. Each moves only once the far side has written the line.
export type Cursor = { local?: number; remote?: number }

const cursorPath = (data: string, peer: Peer) =>
  join(data, "ops", "peer-relay", `${peer.name}.json`)

const readCursor = async (path: string): Promise<Cursor> => {
  const raw = (await Bun.file(path)
    .json()
    .catch(() => ({}))) as Record<string, unknown>
  const offset = (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined
  return { local: offset(raw?.local), remote: offset(raw?.remote) }
}

// One far end as the relay drives it: ssh in the job, a local agent.ts in a test.
export type Far = {
  exited: Promise<number>
  kill: () => void
  stderr: Promise<string>
  stdin: { end: () => unknown; flush: () => unknown; write: (text: string) => unknown }
  stdout: AsyncIterable<Uint8Array>
}

export type Link = {
  data: string
  far: Far
  // the key ssh reaches the peer with, for the down line's words
  key?: string
  notify: (text: string) => Promise<unknown>
  peer: Peer
  pollMs?: number
  // how long the far end has to say hello, and to answer one line
  replyMs?: number
  signal: AbortSignal
  // called once the far end reported its start, so the loop can say up
  up?: () => unknown
}

// One connection until it drops: the far end's hello, then its lines copied here and this machine's own sent there, each cursor saved once the line is written; the far end is ended by its own handle on a drop or the signal. Resolves with why it ended, "" when the signal ended it.
export async function link({
  data,
  far,
  key = "the factory's key",
  notify,
  peer,
  pollMs = 500,
  replyMs = 20_000,
  signal,
  up,
}: Link): Promise<string> {
  const queue = join(data, "ops", "outbox", PEER_QUEUE)
  const path = cursorPath(data, peer)
  await mkdir(join(data, "ops", "peer-relay"), { recursive: true })
  const cursor = await readCursor(path)
  if (cursor.local === undefined) cursor.local = Bun.file(queue).size
  let saves = Promise.resolve()
  const save = () => (saves = saves.then(() => writeAtomic(path, JSON.stringify(cursor))))
  await save()
  let ended = false
  let why = ""
  let stoppedResolve: () => void = () => {}
  let endResolve: () => void = () => {}
  const stopped = new Promise<void>((done) => (stoppedResolve = done))
  const endSeen = new Promise<"end">((done) => (endResolve = () => done("end")))
  const stop = (reason: string) => {
    if (ended) return
    ended = true
    why = reason
    stoppedResolve()
    far.kill()
  }
  const onAbort = () => stop("")
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  const skippedHere = (count: number, where: string) =>
    count
      ? notify(
          `passed over ${count} line${count === 1 ? "" : "s"} in ${where}'s ${PEER_QUEUE}: not a peer line, or over 16 KB`,
        ).catch(console.error)
      : undefined
  let acked: ((id: unknown) => void) | undefined
  // the far end's first word: its hello, another line, its end, or silence past replyMs
  let hello: (said: "hello" | "other" | "ended" | "silent") => void = () => {}
  const greeted = new Promise<"hello" | "other" | "ended" | "silent">((done) => (hello = done))
  const reading = (async () => {
    let first = true
    for await (const text of linesOf(far.stdout)) {
      const message = parsed(text) as Record<string, unknown> | undefined
      if (first) {
        first = false
        hello(
          message?.hello === HELLO.hello && message?.version === HELLO.version ? "hello" : "other",
        )
        continue
      }
      if (!message) continue
      if ("ack" in message) {
        acked?.(message.ack)
        continue
      }
      const line = message.line
      if (isPeerLine(line) && !line.relayedAt) await appendOnce(queue, line)
      if (typeof message.skipped === "number") await skippedHere(message.skipped, peer.name)
      if (Number.isInteger(message.end)) {
        cursor.remote = message.end as number
        await save()
        endResolve()
      }
    }
    hello("ended")
  })().catch((error) => stop(`the far end's stream failed: ${(error as Error).message}`))
  void far.exited.then(() => hello("ended"))
  const timer = setTimeout(() => hello("silent"), replyMs)
  const said = await greeted
  clearTimeout(timer)
  if (said !== "hello" && !ended) {
    far.kill()
    const code = await far.exited
    const stderr = (await far.stderr).trim()
    stop(
      said === "other" || lacking(stderr)
        ? LACKS
        : stderr
          ? whyOf(stderr, { host: peer.target, key, port: 0, user: "" }, code)
          : said === "silent"
            ? `${peer.target} said no hello within ${replyMs / 1000}s`
            : `${peer.target} ended with code ${code} before its hello`,
    )
  }
  void far.exited.then((code) => stop(`ssh to ${peer.target} ended with code ${code}`))
  // count the link up only once the far has reported its start, so a line it already holds is read from, never read past
  const startTimer = setTimeout(
    () => stop(`${peer.target} reported no start within ${replyMs / 1000}s`),
    replyMs,
  )
  const seen = await Promise.race([endSeen, stopped])
  clearTimeout(startTimer)
  if (!ended && seen === "end") up?.()
  const send = async (line: PeerLine): Promise<boolean> => {
    const answer = new Promise<unknown>((done) => (acked = done))
    far.stdin.write(`${JSON.stringify({ line })}\n`)
    far.stdin.flush()
    const id = await Promise.race([
      answer,
      far.exited.then(() => undefined),
      Bun.sleep(replyMs).then(() => undefined),
    ])
    acked = undefined
    return id === line.id
  }
  while (!ended) {
    const { end, reads, skipped } = await linesFrom(queue, cursor.local!)
    for (const { end, line } of reads) {
      if (!line.relayedAt && !(await send(line))) {
        stop(`${peer.target} wrote no answer for a line within ${replyMs / 1000}s`)
        break
      }
      cursor.local = end
      await save()
    }
    if (ended) break
    await skippedHere(skipped, "this machine")
    if (end !== cursor.local) {
      cursor.local = end
      await save()
    }
    await Promise.race([far.exited, Bun.sleep(pollMs)])
  }
  far.stdin.end()
  await far.exited
  await reading
  await saves
  signal.removeEventListener("abort", onAbort)
  if (why.startsWith("ssh to ")) {
    const stderr = (await far.stderr).trim()
    if (stderr) why = whyOf(stderr, { host: peer.target, key, port: 0, user: "" }, await far.exited)
  }
  return why
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done()
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true })
  })

export type KeepOptions = {
  checkout: string
  data: string
  // the .env's text, read again at each start, so a peer set later takes effect with no restart
  envText: () => Promise<string>
  home: string
  maxWaitMs?: number
  minWaitMs?: number
  notify: (text: string) => Promise<unknown>
  // the far end for a peer, from the remote cursor
  open?: (key: string, peer: Peer, from: number | "end") => Far
  path?: string
  pollMs?: number
  replyMs?: number
  signal: AbortSignal
  // a link up this long starts the next wait from minWaitMs again
  steadyMs?: number
  // the timer that re-emits the first state each cycle, a row runs it in milliseconds
  timerMs?: number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const sshFar =
  (ssh: string, checkout: string) =>
  (key: string, peer: Peer, from: number | "end"): Far => {
    const child = Bun.spawn([ssh, ...sshArgs(key, peer.target, checkout, from)], {
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    })
    return {
      exited: child.exited,
      kill: () => child.kill(),
      stderr: new Response(child.stderr).text(),
      stdin: child.stdin,
      stdout: child.stdout,
    }
  }

// The job's loop until signal: one link per peer, each beating its state into the job's heartbeat, which reads ok while every peer is up, and on a drop telling Ops once per down spell, and once when it is up again, then starting again after a wait that doubles from minWaitMs to maxWaitMs, from minWaitMs again once a link held steadyMs.
export async function keep({
  checkout,
  data,
  envText,
  home,
  maxWaitMs = 60_000,
  minWaitMs = 2_000,
  notify,
  open,
  path = join(data, "ops", `${JOB}.json`),
  pollMs,
  replyMs,
  signal,
  steadyMs = 60_000,
  timerMs = 60_000,
  wait = sleep,
}: KeepOptions): Promise<void> {
  const startedAt = new Date()
  const states = new Map<string, string>()
  let writes = Promise.resolve()
  const say = (peer: string, state: string) => {
    states.set(peer, state)
    // ok while every peer is up, which the sweep reads as healthy; else each state, naming the peer that is down
    const line = [...states.values()].every((said) => said.startsWith("up: "))
      ? "ok"
      : [...states].map(([name, said]) => `${name}: ${said}`).join("; ")
    writes = writes.then(() => beat(path, startedAt, new Date(), line, JOB)).catch(console.error)
    return writes
  }
  const timer = setInterval(() => {
    const [first] = states
    if (first) void say(first[0], first[1])
  }, timerMs)
  const ssh = Bun.which("ssh")
  const far = open ?? (ssh ? sshFar(ssh, checkout) : undefined)
  const running = new Map<string, Promise<void>>()
  const one = async (name: string) => {
    let next = minWaitMs
    let down = false
    while (!signal.aborted) {
      const cluster = clusterOf(envKeysOf(await envText()), home)
      if ("why" in cluster) return void states.delete(name)
      const peer = cluster.peers.find((p) => p.name === name)
      if (!peer) return void states.delete(name)
      const missing = !existsSync(cluster.key)
        ? `the key ${cluster.key} is missing`
        : !far
          ? "no ssh on PATH"
          : null
      if (missing) {
        await say(name, `down: ${missing}`)
        if (!down) await notify(`${name}: down: ${missing}`).catch(console.error)
        down = true
        await wait(maxWaitMs, signal)
        continue
      }
      const { remote } = await readCursor(cursorPath(data, peer))
      let upAt = 0
      const why = await link({
        data,
        far: far!(cluster.key, peer, remote ?? "end"),
        key: cluster.key,
        notify: (text) => notify(`${name}: ${text}`),
        peer,
        pollMs,
        replyMs,
        signal,
        up: () => {
          upAt = Date.now()
          void say(name, `up: copying ${PEER_QUEUE} both ways with ${peer.target}`)
          if (down)
            void notify(`${name}: up again: copying ${PEER_QUEUE} both ways`).catch(console.error)
          down = false
        },
      })
      if (signal.aborted) break
      if (upAt && Date.now() - upAt >= steadyMs) next = minWaitMs
      const slow = why === LACKS
      await say(
        name,
        `down: ${why}; ssh starts again in ${Math.ceil((slow ? maxWaitMs : next) / 1000)}s`,
      )
      if (!down) await notify(`${name}: down: ${why}; it retries`).catch(console.error)
      down = true
      await wait(slow ? maxWaitMs : next, signal)
      if (!slow) next = Math.min(next * 2, maxWaitMs)
    }
  }
  while (!signal.aborted) {
    const cluster = clusterOf(envKeysOf(await envText()), home)
    if ("why" in cluster) await say(JOB, `down: ${cluster.why}`)
    else if (!cluster.peers.length) {
      states.delete(JOB)
      writes = writes
        .then(() => beat(path, startedAt, new Date(), "idle: PLAYGROUND_PEERS names no peer", JOB))
        .catch(console.error)
    } else {
      states.delete(JOB)
      for (const peer of cluster.peers)
        if (!running.has(peer.name))
          running.set(
            peer.name,
            one(peer.name).finally(() => running.delete(peer.name)),
          )
    }
    await wait(maxWaitMs, signal)
  }
  await Promise.all(running.values())
  clearInterval(timer)
  await writes
}
