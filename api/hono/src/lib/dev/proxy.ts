import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

// Whether a folder's proxy.pid names a live process; a root proxy's answers EPERM, which is live too.
const serving = (dir: string): boolean => {
  try {
    const pid = Number(readFileSync(join(dir, "proxy.pid"), "utf8").trim())
    if (!(pid > 0)) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// portless's state folder: PORTLESS_STATE_DIR, else ~/.portless, or its fallback folder while the 1355 proxy there serves and portless's own does not, so a process outside the stack (the supervisor's web route, health-beat) reads the routes the stack wrote.
export const portlessDir = (env: Record<string, string | undefined> = process.env): string => {
  if (env.PORTLESS_STATE_DIR) return env.PORTLESS_STATE_DIR
  const dir = join(env.HOME || homedir(), ".portless")
  return !serving(dir) && serving(fallbackDir(dir)) ? fallbackDir(dir) : dir
}

// Whether anything takes a connection on a loopback port.
export const listening = (port: number, timeout = 500): Promise<boolean> =>
  new Promise((done) => {
    const timer = setTimeout(() => done(false), timeout)
    const settle = (answered: boolean) => {
      clearTimeout(timer)
      done(answered)
    }
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        open(socket) {
          socket.end()
          settle(true)
        },
      },
    }).catch(() => settle(false))
  })

const UNPREFIXED = new Set(["main", "master"])

// The prefix portless gives a linked worktree's stack, as its cli.js names it (branchToPrefix and sanitizeForHostname): the branch's last segment, lowercased, with anything but letters, digits and hyphens turned to hyphens, runs of them merged and the ends trimmed; none on main or master, or when nothing is left. Its truncation of a label past 63 characters ends in a hash, so it never yields a short prefix such as dashboard.
export const prefixOf = (branch: string): string | null => {
  if (UNPREFIXED.has(branch)) return null
  const prefix = (branch.split("/").at(-1) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  return prefix || null
}

// The unprivileged port a stack starts portless's proxy on while the one below 1024 is down: it needs no sudo, so no terminal, and every stack keeps its name on it.
export const FALLBACK_PORT = 1355

// The folder the 1355 proxy keeps its state in, inside portless's own: a service install reads portless's own folder alone, so it leaves this proxy, and every stack on it, running until each next start lands on 443.
export const fallbackDir = (dir: string): string => join(dir, "fallback")

// Whether a stack's state folder is the 1355 proxy's fallback folder.
export const isFallback = (dir: string): boolean => basename(dir) === "fallback"

const readOrNull = (path: string): Buffer | null => {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

// The fallback's CA and the leaf portless signed with it, by name, since portless renews a leaf only on its expiry.
const FALLBACK_CERTS = ["ca.pem", "ca-key.pem", "server.pem", "server-key.pem"]

// Copies portless's own CA into the fallback folder when it holds one, the key at mode 600, so the 1355 proxy serves under the CA the owner trusted for 443; a fallback CA that differs goes with its leaves, host-certs through discard (the trash), as portless's own generateCA clears them; reads portless's folder alone; answers whether the fallback's CA is that one. Trusting a CA stays the owner's click.
export const shareCa = (
  own: string,
  fallback: string,
  discard: (path: string) => string | null,
): boolean => {
  const cert = readOrNull(join(own, "ca.pem"))
  const key = readOrNull(join(own, "ca-key.pem"))
  if (!cert || !key) return false
  try {
    const held = readOrNull(join(fallback, "ca.pem"))
    if (held?.equals(cert)) return true
    if (held || existsSync(join(fallback, "ca-key.pem"))) {
      if (discard(join(fallback, "host-certs")) !== null) return false
      for (const name of FALLBACK_CERTS) rmSync(join(fallback, name), { force: true })
    }
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(fallback, "ca-key.pem"), key, { flag: "wx", mode: 0o600 })
    writeFileSync(join(fallback, "ca.pem"), cert, { flag: "wx", mode: 0o644 })
  } catch {
    return false
  }
  return readOrNull(join(fallback, "ca.pem"))?.equals(cert) ?? false
}

// portless's own folder for a stack's state folder, the one a fallback folder sits in.
export const serviceDir = (dir: string): string => (isFallback(dir) ? dirname(dir) : dir)

// The port portless serves on here: the one it saved, else PORTLESS_PORT, else 443.
export const proxyPort = async (
  env: Record<string, string | undefined>,
  dir = portlessDir(),
): Promise<number> => {
  const saved = Bun.file(join(dir, "proxy.port"))
  return (await saved.exists())
    ? Number((await saved.text()).trim())
    : Number(env.PORTLESS_PORT) || 443
}

// The port below 1024 portless's proxy belongs on and does not answer, which only sudo starts: a fresh machine before `portless service install` keeps it on 443, or a service that stopped; a saved 1355 that answers nothing reads as 443 down too, so its next start goes through startFallback, never portless's own start, which trusts the CA with no click; null when the stack skips portless, its port needs no sudo and answers, or the proxy answers.
export const proxyDown = async (
  env: Record<string, string | undefined>,
  dir = portlessDir(),
  listens = listening,
): Promise<number | null> => {
  if (env.PORTLESS === "0") return null
  const port = await proxyPort(env, dir)
  if (port === FALLBACK_PORT) return (await listens(port)) ? null : 443
  if (port >= 1024 || (await listens(port))) return null
  return port
}

// What the owner runs once, in a terminal, to put the proxy on its port below 1024: the setup a stack cannot do itself.
export const proxySetup = (port: number): string =>
  `portless's proxy is not running, and starting it on port ${port} needs sudo, which a stack cannot ask for; once, in a terminal in the main checkout, run \`sudo node_modules/.bin/portless service install\` and then \`node_modules/.bin/portless trust\`, or start on fixed ports with \`PORTLESS=0 bun run dev\``

// Starts portless's proxy on FALLBACK_PORT as this user, through the checkout's own portless (cli), with its trust step skipped, since trusting a certificate waits for the owner's click (Set up the web address, or Trust the certificate on 443); it serves under portless's own CA once shareCa has copied it; answers why it is still not listening, else null. A proxy another stack started there first counts as started.
export const startFallback = async (
  cli: string,
  env: Record<string, string | undefined>,
  listens = listening,
): Promise<string | null> => {
  const run = Bun.spawnSync([cli, "proxy", "start", "-p", String(FALLBACK_PORT), "--skip-trust"], {
    env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
    timeout: 60_000,
  })
  if (await listens(FALLBACK_PORT, 2_000)) return null
  const said = Bun.stripANSI(`${run.stdout}${run.stderr}`).trim().split("\n").at(-1)
  return said || `portless exited ${run.exitCode ?? run.signalCode}`
}
