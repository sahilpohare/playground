import { existsSync } from "node:fs"
import { join } from "node:path"
import { connect } from "node:tls"

import { FALLBACK_PORT, listening, prefixOf } from "../../../../api/hono/src/lib/dev/proxy"
import { beat } from "../ops-tick/tick"
import { liveBranch } from "../playground/probe"

// ops-tunnel: holds an ssh tunnel from this Mac's loopback to another machine's loopback Dashboard, on the same port at both ends, so the link is that machine's own web origin, which its trusted origins and the URLs its web build holds already name. It runs on the Mac alone, and nothing of it runs on the far machine.
export const JOB = "ops-tunnel"

// The factory's key for the far machine, by path alone: its text is never read here, only ssh reads it; ops-peer-relay falls back to it too.
export const KEY = "~/.ssh/playground_spark"

export type Tunnel = { host: string; key: string; port: number; user: string }

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

// Pure: the job's row config as a tunnel: host is the far machine's name or address, "" until set; the key, port and user fall back to the factory's key, portless's no-sudo port and this Mac's user.
export const tunnelOf = (config: unknown, home: string, user: string): Tunnel => {
  const row = (config && typeof config === "object" ? config : {}) as Record<string, unknown>
  const key = text(row.key) || KEY
  const port = Number(row.port)
  return {
    host: text(row.host),
    key: key.startsWith("~/") ? join(home, key.slice(2)) : key,
    port: Number.isInteger(port) && port >= 1024 && port < 65536 ? port : FALLBACK_PORT,
    user: text(row.user) || user,
  }
}

// Pure: ssh's argv: no remote command, the key alone and no prompt, and the port on this Mac's loopback forwarded to the same port on the far machine's loopback; a forward that cannot bind ends ssh, so the job says why. -F none keeps the user's own ssh config out of it.
export const sshArgs = ({ host, key, port, user }: Tunnel): string[] => [
  "-N",
  "-F",
  "none",
  "-i",
  key,
  ...["BatchMode=yes", "ConnectTimeout=10", "ExitOnForwardFailure=yes", "IdentitiesOnly=yes"]
    .concat(["ServerAliveCountMax=3", "ServerAliveInterval=15"])
    .flatMap((option) => ["-o", option]),
  "-L",
  `127.0.0.1:${port}:127.0.0.1:${port}`,
  `${user}@${host}`,
]

// Pure: the live Dashboard's web host as portless names its checkout, the worktree on live.branch (dashboard.playground.localhost on live/dashboard), which the link and the certificate served there name.
export const webHostOf = (branch: string): string => {
  const prefix = prefixOf(branch)
  return `${prefix ? `${prefix}.` : ""}playground.localhost`
}

// Pure: the Dashboard's link through the tunnel, the far machine's own portless origin.
export const linkOf = (port: number, webHost: string): string =>
  `https://${webHost}:${port}/dashboard`

// Pure: why ssh ended, in plain words from its stderr, else its last line as it said it, else its exit code.
export const whyOf = (stderr: string, { host, key, port }: Tunnel, code: number): string => {
  const said = (pattern: RegExp) => pattern.test(stderr)
  if (said(/Identity file .* not accessible|Load key .*: No such file/))
    return `the key ${key} is missing`
  if (said(/Permission denied/))
    return `${host} refused the key ${key}: its public key is not in that machine's authorized_keys`
  if (said(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/))
    return `host key unknown or changed for ${host}: this Mac's known_hosts must hold that machine's key`
  if (said(/Could not resolve hostname/)) return `${host} does not resolve to an address`
  if (said(/Connection refused/)) return `nothing answers ssh on ${host}`
  if (said(/timed out|No route to host|Network is unreachable|Host is down/))
    return `${host} is not reachable on the network`
  if (said(/Address already in use|cannot listen to port|forwarding failed/))
    return `port ${port} on this Mac is taken by another program`
  const last = stderr.trim().split("\n").at(-1)?.trim()
  return last ? `ssh said: ${last}` : `ssh ended with code ${code}`
}

// The tunnel job's row config, read from jobs.json at each start, so a host set later takes effect with no restart.
const configOf = async (data: string): Promise<unknown> => {
  try {
    const { jobs } = await Bun.file(join(data, "ops", "jobs.json")).json()
    return (jobs as { config?: unknown; name?: string }[]).find((job) => job.name === JOB)?.config
  } catch {
    return undefined
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done()
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true })
  })

// The Inbox card's record: the link last posted, so each link posts once.
const cardPath = (data: string) => join(data, "ops", "tunnel", "card.json")

const postOnce = async (
  data: string,
  link: string,
  host: string,
  post: (link: string, host: string) => Promise<string | null>,
) => {
  const posted = await Bun.file(cardPath(data))
    .json()
    .then((saved: { link?: string }) => saved.link)
    .catch(() => undefined)
  if (posted === link) return
  const id = await post(link, host)
  if (!id) return
  await Bun.write(cardPath(data), JSON.stringify({ id, link }))
}

const pemOf = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`

// The certificate the far Dashboard serves through the tunnel for the link's host, as PEM, or null when nothing answers with one.
const servedCert = (port: number, webHost: string): Promise<string | null> =>
  new Promise((done) => {
    const socket = connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, servername: webHost },
      () => {
        const raw = socket.getPeerCertificate()?.raw
        socket.end()
        done(raw ? pemOf(raw) : null)
      },
    )
    socket.setTimeout(10_000, () => (socket.destroy(), done(null)))
    socket.on("error", () => done(null))
  })

// Whether this Mac trusts what the far Dashboard serves through the tunnel, by macOS's own trust store, the one a browser on the Mac reads: null when it does, else why.
export const servedWhy = async (
  port: number,
  host: string,
  webHost: string,
  data: string,
): Promise<string | null> => {
  const pem = await servedCert(port, webHost)
  if (!pem) return `the Dashboard on ${host} does not answer through the tunnel on port ${port}`
  const file = join(data, "ops", "tunnel", "served.pem")
  await Bun.write(file, pem)
  const verify = Bun.spawnSync([
    "/usr/bin/security",
    "verify-cert",
    "-q",
    "-c",
    file,
    "-p",
    "ssl",
    "-s",
    webHost,
  ])
  return verify.exitCode === 0
    ? null
    : `this Mac does not trust the certificate the Dashboard on ${host} serves yet: its portless CA is not trusted here`
}

export type KeepOptions = {
  // the live Dashboard's branch, live.branch, which names its web host
  branch?: () => string
  data: string
  env: Record<string, string | undefined>
  home?: string
  listens?: (port: number) => Promise<boolean>
  maxWaitMs?: number
  minWaitMs?: number
  post?: (link: string, host: string) => Promise<string | null>
  // null when the far Dashboard answers through the tunnel with a certificate this Mac trusts, else why
  served?: (port: number, host: string, webHost: string) => Promise<string | null>
  signal: AbortSignal
  // a link up this long starts the next wait from minWaitMs again
  steadyMs?: number
  user?: string
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

// The job's loop until signal: starts ssh, beats up once the port answers and the Dashboard behind it serves a certificate this Mac trusts, checked again each minute, and posts the link once; and on a drop beats down with why and starts ssh again after a wait that doubles from minWaitMs to maxWaitMs, from minWaitMs again once a link held steadyMs. A missing host or key, or a port another program already answers on, starts no ssh. Its ssh is ended by its own handle on the signal.
export const keep = async ({
  branch = liveBranch,
  data,
  env,
  home = env.HOME ?? "",
  listens = (port) => listening(port),
  maxWaitMs = 60_000,
  minWaitMs = 2_000,
  post,
  served = (port, host, webHost) => servedWhy(port, host, webHost, data),
  signal,
  steadyMs = 60_000,
  user = env.USER ?? "",
  wait = sleep,
}: KeepOptions): Promise<void> => {
  const path = join(data, "ops", `${JOB}.json`)
  const startedAt = new Date()
  let state = "starting"
  let writes = Promise.resolve()
  const say = (next: string) => {
    state = next
    writes = writes.then(() => beat(path, startedAt, new Date(), state, JOB)).catch(console.error)
    return writes
  }
  const timer = setInterval(() => void say(state), 60_000)
  const ssh = Bun.which("ssh", { PATH: env.PATH ?? "" })
  let next = minWaitMs
  while (!signal.aborted) {
    const tunnel = tunnelOf(await configOf(data), home, user)
    if (signal.aborted) break
    const missing = !tunnel.host
      ? `no host set: the jobs.opsTunnel setting's config.host names the machine to reach`
      : !existsSync(tunnel.key)
        ? `the key ${tunnel.key} is missing`
        : !ssh
          ? "no ssh on PATH"
          : null
    if (missing) {
      await say(`down: ${missing}`)
      await wait(maxWaitMs, signal)
      continue
    }
    // a port that answers before ssh starts is another program's, whose answer would read as the tunnel's
    if (await listens(tunnel.port)) {
      await say(`down: port ${tunnel.port} on this Mac is taken by another program`)
      await wait(next, signal)
      next = Math.min(next * 2, maxWaitMs)
      continue
    }
    let webHost: string
    try {
      webHost = webHostOf(branch())
    } catch (error) {
      await say(`down: the live.branch setting cannot be read: ${(error as Error).message}`)
      await wait(maxWaitMs, signal)
      continue
    }
    const child = Bun.spawn([ssh!, ...sshArgs(tunnel)], {
      env,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "ignore",
    })
    const stop = () => child.kill()
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) stop()
    const stderr = new Response(child.stderr).text()
    let upAt = 0
    let checkAt = 0
    let ended = false
    void child.exited.then(() => (ended = true))
    while (!ended && !signal.aborted) {
      if (!upAt && (await listens(tunnel.port)) && !ended) upAt = Date.now()
      if (upAt && Date.now() >= checkAt && !ended) {
        checkAt = Date.now() + 60_000
        const why = await served(tunnel.port, tunnel.host, webHost)
        const link = linkOf(tunnel.port, webHost)
        if (ended || signal.aborted) break
        await say(why ? `down: ${why}` : `up: ${link} through ${tunnel.host}`)
        if (!why && post) await postOnce(data, link, tunnel.host, post).catch(console.error)
      }
      await Promise.race([child.exited, Bun.sleep(upAt ? 1_000 : 250)])
    }
    const code = await child.exited
    signal.removeEventListener("abort", stop)
    if (signal.aborted) break
    if (upAt && Date.now() - upAt >= steadyMs) next = minWaitMs
    await say(
      `down: ${whyOf(await stderr, tunnel, code)}; ssh starts again in ${Math.ceil(next / 1000)}s`,
    )
    await wait(next, signal)
    next = Math.min(next * 2, maxWaitMs)
  }
  clearInterval(timer)
  await writes
}
