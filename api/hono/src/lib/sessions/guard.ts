import { SQL } from "bun"

import { identifierOf, servingPort } from "@/lib/pglite"

// Transcripts hold secrets and customer data, so the importer writes only to a Postgres it can prove is on this machine: the URL names a loopback host, a local Docker container publishes the URL's port on loopback alone (but first run's own, below) or this machine's PGlite server listens on it (lib/pglite.ts, which binds 127.0.0.1 alone), and the server the URL reaches is that one's own (the same system identifier). A tunnel to a remote database (an SSH forward, cloud-sql-proxy, a Neon pooler) bound to 127.0.0.1 fails the last two.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"])

// Each way the guard refuses, so a caller can name the fix for it: a host off this machine, Docker missing or not answering, a container that vanished while Docker was read, no single container publishing the port, a container published beyond loopback, one that is not Postgres, and a server that is not the container's own.
export type GuardFailure =
  | "remote"
  | "no-docker"
  | "docker-down"
  | "vanished"
  | "no-owner"
  | "exposed"
  | "not-postgres"
  | "other-server"

export class GuardError extends Error {
  constructor(
    readonly failure: GuardFailure,
    message: string,
  ) {
    super(message)
    this.name = "GuardError"
  }
}

export type Target = { database: string; host: string; port: number }

export const targetOf = (url: string): Target => {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new GuardError("remote", `POSTGRES_URL points at ${host}, not this machine`)
  }
  return {
    database: decodeURIComponent(parsed.pathname.slice(1)) || "postgres",
    host,
    port: Number(parsed.port || 5432),
  }
}

const DOTENV_URL = /^[ \t]*(?:export[ \t]+)?POSTGRES_URL[ \t]*=[ \t]*["']?([^"'\s#]+)/gm

const portOf = (url: string): number | null =>
  URL.canParse(url) ? Number(new URL(url).port || 5432) : null

// Pure: why a URL is not its own checkout's, its port against the one that checkout's .env names: a script run by path from another checkout, or a POSTGRES_URL exported in the shell over the .env; null when the two agree, or the .env is missing or names none.
export const checkoutMismatch = (url: string, dotenv: string | null): string | null => {
  // the last line wins, as a .env loader reads it
  const own = dotenv === null ? undefined : [...dotenv.matchAll(DOTENV_URL)].at(-1)?.[1]
  const [port, ownPort] = [portOf(url), own === undefined ? null : portOf(own)]
  if (port === null || ownPort === null || port === ownPort) return null
  return `POSTGRES_URL names port ${port}, while this checkout's .env names port ${ownPort}; run it as bun --cwd=<checkout> run <script> in the checkout whose database you mean`
}

export type Published = { addresses: string[]; id: string; image: string; name: string }

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === "string" ? value : "")

// From `docker inspect` of the running containers: each one that publishes the host port, with every host address it binds it on.
export const publishedOn = (inspect: unknown, port: number): Published[] =>
  (Array.isArray(inspect) ? inspect.filter(isRecord) : []).flatMap((container) => {
    const network = isRecord(container.NetworkSettings) ? container.NetworkSettings : {}
    const ports = isRecord(network.Ports) ? network.Ports : {}
    const addresses = Object.values(ports)
      .flatMap((bindings) => (Array.isArray(bindings) ? bindings.filter(isRecord) : []))
      .filter((binding) => str(binding.HostPort) === String(port))
      .map((binding) => str(binding.HostIp))
    if (addresses.length === 0) return []
    const config = isRecord(container.Config) ? container.Config : {}
    return [
      {
        addresses,
        id: str(container.Id),
        image: str(config.Image),
        name: str(container.Name).replace(/^\//, ""),
      },
    ]
  })

// An empty HostIp, 0.0.0.0 or :: publishes the port on every interface.
export const loopbackOnly = (addresses: string[]): boolean =>
  addresses.length > 0 && addresses.every((address) => LOOPBACK_ADDRESSES.has(address))

// First run's own database (lib/setup/container.ts): pglaunch, which the owner chose as it is for that step, publishes on every interface and names the container the checkout's name plus a dash and 4 letters or digits, so that container alone may be published beyond loopback.
const FIRST_RUN_CONTAINER = /^playground(?:-[a-zA-Z0-9_.-]+)?-db-[0-9a-zA-Z]{4}$/

export const systemIdentifierOf = (controlData: string): string | null =>
  /Database system identifier:\s*(\d+)/.exec(controlData)?.[1] ?? null

// A failed `docker ps` or `inspect` means Docker is not answering; a failed `exec` means the container cannot run pg_controldata, so it is no Postgres the guard can prove.
export type Docker = (args: string[], failure?: GuardFailure) => string

const docker: Docker = (args, failure = "docker-down") => {
  if (!Bun.which("docker")) {
    throw new GuardError(
      "no-docker",
      "docker is not on PATH, so the database cannot be proved local",
    )
  }
  const result = Bun.spawnSync(["docker", ...args], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new GuardError(
      failure,
      `docker ${args[0]} failed: ${result.stderr.toString().trim().slice(0, 200)}`,
    )
  }
  return result.stdout.toString()
}

// pglite names the PGlite folder that owns the port, whose identifier the proof reads in place of the container's.
export type Located = { owner: Published; pglite?: string; target: Target }

const VANISHED = /no such (?:object|container):\s*(\S+)/i

// A container `docker ps` listed can be removed before `docker inspect` reads it (another stack's database stopping), which fails the whole inspect, so one vanish re-lists once and the gone container drops out of the list; a second refuses, naming the container, since Docker itself answered.
const publishers = (port: number, run: Docker): Published[] => {
  for (let relisted = false; ; relisted = true) {
    const ids = run(["ps", "-q"]).split("\n").filter(Boolean)
    if (ids.length === 0) return []
    try {
      return publishedOn(JSON.parse(run(["inspect", ...ids])), port)
    } catch (error) {
      const gone = error instanceof GuardError ? VANISHED.exec(error.message)?.[1] : undefined
      if (!gone) throw error
      if (relisted) {
        throw new GuardError(
          "vanished",
          `container ${gone} was removed while the check read Docker, the second in a row`,
        )
      }
    }
  }
}

// The running PGlite server on the URL's port, else the one running container that publishes it, on loopback alone but for first run's own, read from Docker's metadata: nothing runs inside it and nothing connects to it, so a caller can refuse a container by name before touching it.
export const locate = (
  url: string,
  run: Docker = docker,
  pglite: (port: number) => { home: string; name: string } | undefined = servingPort,
): Located => {
  const target = targetOf(url)
  const lite = pglite(target.port)
  if (lite) {
    const owner = { addresses: ["127.0.0.1"], id: lite.home, image: "pglite", name: lite.name }
    return { owner, pglite: lite.home, target }
  }
  const owners = publishers(target.port, run)
  const [owner] = owners
  if (!owner || owners.length > 1) {
    throw new GuardError(
      "no-owner",
      `no single running Docker container publishes port ${target.port}`,
    )
  }
  if (!loopbackOnly(owner.addresses) && !FIRST_RUN_CONTAINER.test(owner.name)) {
    const where = owner.addresses.map((address) => address || "every interface").join(", ")
    throw new GuardError(
      "exposed",
      `${owner.name} publishes port ${target.port} beyond loopback (${where})`,
    )
  }
  return { owner, target }
}

// Proves the server the URL reaches is the located container's own Postgres, by the system identifier in its pg_controldata (a PGlite's, in its data folder's pg_control), and returns the proof the importer prints before its first write.
export async function prove(
  url: string,
  { owner, pglite, target }: Located,
  run: Docker = docker,
  pgliteId: (home: string) => string = identifierOf,
): Promise<string> {
  const expected = pglite
    ? pgliteId(pglite)
    : systemIdentifierOf(
        run(["exec", owner.id, "sh", "-c", 'pg_controldata "$PGDATA"'], "not-postgres"),
      )
  if (!expected) {
    throw new GuardError(
      "not-postgres",
      `${owner.name} is not a Postgres container (no pg_controldata)`,
    )
  }
  const sql = new SQL(url, { connectionTimeout: 5, max: 1 })
  try {
    const [row] = await sql`
      select
        current_database() as database,
        current_setting('server_version') as version,
        (select system_identifier::text from pg_control_system()) as system
    `
    if (row?.system !== expected) {
      throw new GuardError(
        "other-server",
        `the server at ${target.host}:${target.port} is not ${owner.name}'s Postgres`,
      )
    }
    return `${target.host}:${target.port}/${row.database} is ${owner.name} (${owner.image}), published on ${[...new Set(owner.addresses)].join(", ")} only, PostgreSQL ${row.version}`
  } finally {
    await sql.close()
  }
}

// Returns the proof the importer prints before its first write, or throws saying which check failed.
export const provenLocal = async (url: string, run: Docker = docker): Promise<string> =>
  prove(url, locate(url, run), run)
