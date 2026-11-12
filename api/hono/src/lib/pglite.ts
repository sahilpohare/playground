import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { type AddressInfo, connect, createServer, type Socket } from "node:net"
import { uptime } from "node:os"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { dataDirOf } from "@packages/env/data-dir"

// A database with no Docker: PGlite (Postgres compiled to WebAssembly) kept in the data folder's pglite/<name>/data and served on 127.0.0.1 by one detached process, so the API and every CLI reach it by a plain POSTGRES_URL as they reach a container. Its URL turns prepared statements off, since every client shares PGlite's one session and two clients' statement names would collide.

export type Record = { home: string; name: string; pid: number; port: number }

const SERVER = join(import.meta.dir, "../bin/pglite.ts")
const START_TRIES = 60
// serve()'s exit code when another server holds the lock.
const HELD = 3

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const CANCEL_REQUEST = 80877102
// A message's length past which the connection is dropped rather than buffered, as Postgres caps a message at 1 GB.
const MAX_MESSAGE = 2 ** 30

const frame = (type: string, body = ""): Uint8Array => {
  const bytes = Buffer.alloc(5 + Buffer.byteLength(body))
  bytes.write(type, 0)
  bytes.writeInt32BE(4 + Buffer.byteLength(body), 1)
  bytes.write(body, 5)
  return bytes
}
// A dropped client's half-run statement: ROLLBACK undoes its writes and its transaction, Sync ends the statement or the error PGlite skips to, so the next client starts clean.
const RESET = [frame("Q", "ROLLBACK\0"), frame("S")]

export const pgliteRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  join(dataDirOf(env), "pglite")

export const urlOf = (port: number): string =>
  `postgres://postgres@127.0.0.1:${port}/postgres?prepare=false`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Whether 127.0.0.1:port takes a connection: a pid alone may be another process's after a reboot.
const listening = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      done(true)
    })
    socket.once("error", () => done(false))
  })

const running = async (record: { pid: number; port: number } | null): Promise<boolean> =>
  record !== null && alive(record.pid) && (await listening(record.port))

const readRecord = (home: string): { pid: number; port: number } | null => {
  try {
    const { pid, port } = JSON.parse(readFileSync(join(home, "server.json"), "utf8"))
    return Number.isInteger(pid) && Number.isInteger(port) ? { pid, port } : null
  } catch {
    return null
  }
}

// Every PGlite database this machine keeps, running or not.
export const records = (root: string = pgliteRoot()): Record[] =>
  existsSync(root)
    ? readdirSync(root).flatMap((name) => {
        const home = join(root, name)
        const record = readRecord(home)
        return record ? [{ home, name, ...record }] : []
      })
    : []

// The running PGlite that serves port, the guard's owner in place of a container.
export const servingPort = (port: number, root?: string): Record | undefined =>
  records(root).find((record) => record.port === port && alive(record.pid))

// The system identifier PGlite wrote into its own data folder, the proof the guard checks the server against, as a container's pg_controldata.
export const identifierOf = (home: string): string =>
  readFileSync(join(home, "data", "global", "pg_control"))
    .readBigUInt64LE(0)
    .toString()

// Starts name's server unless it runs, and returns its URL once it listens; a server that exits first throws with its log's last line.
export async function startPglite(
  name: string,
  {
    root = pgliteRoot(),
    wait = Bun.sleep,
  }: { root?: string; wait?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const home = join(root, name)
  const before = readRecord(home)
  if (await running(before)) return urlOf(before!.port)
  mkdirSync(home, { recursive: true })
  const log = openSync(join(home, "server.log"), "a")
  const child = spawn(process.execPath, [SERVER, home], {
    detached: true,
    stdio: ["ignore", log, log],
  })
  child.unref()
  for (let tries = 0; tries < START_TRIES; tries++) {
    const record = readRecord(home)
    if (record && record.pid === child.pid) return urlOf(record.port)
    // A start that lost serve()'s lock waits for the winner's server and takes it.
    if (
      child.exitCode === HELD &&
      record &&
      record.pid !== before?.pid &&
      (await running(record))
    ) {
      return urlOf(record.port)
    }
    if (child.exitCode !== null && child.exitCode !== HELD) break
    await wait(500)
  }
  const said = readFileSync(join(home, "server.log"), "utf8").trim().split("\n").at(-1)
  throw new Error(`PGlite in ${home} did not start${said ? `: ${said}` : ""}`)
}

// Restarts the PGlite a URL names when its server has stopped (after a reboot), as `docker start` would its container; a URL no PGlite record names is left alone, and one two records name is refused, since either could be a stale checkout's.
export async function ensurePglite(url: string, root?: string): Promise<void> {
  if (!URL.canParse(url)) return
  const port = Number(new URL(url).port || 5432)
  const named = records(root).filter((r) => r.port === port)
  if (named.length > 1) {
    throw new Error(
      `PGlite databases ${named.map((r) => r.name).join(" and ")} both record port ${port}, so POSTGRES_URL could name either; remove the stale one's folder under ${root ?? pgliteRoot()}`,
    )
  }
  const [record] = named
  if (record && !(await running(record))) await startPglite(record.name, { root })
}

// Takes home's server.lock (O_EXCL), so two starts racing on one name never run two servers on one data folder; a lock whose pid is gone or that predates this boot is stale and taken over, and the lock goes when the server exits. Exits HELD when a live server holds it.
const lock = (home: string): void => {
  const file = join(home, "server.lock")
  const drop = () => {
    try {
      unlinkSync(file)
    } catch {}
  }
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(file, "wx")
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      process.on("exit", drop)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    try {
      const holder = Number(readFileSync(file, "utf8"))
      const booted = Date.now() - uptime() * 1000
      if (alive(holder) && statSync(file).mtimeMs > booted) break
    } catch {
      continue
    }
    // ponytail: two starts taking over one stale lock at once can both win; a flock would close that.
    drop()
  }
  console.error(`pglite: ${home} is already served (server.lock)`)
  process.exit(HELD)
}

// The server: PGlite has one session, so a connection holds it from its first message to its Sync or simple Query, and for as long as a transaction it opened stays open; no other client's message lands inside its statement or its transaction.
export async function serve(home: string): Promise<void> {
  lock(home)
  const pg = await PGlite.create(join(home, "data"))
  let owner: Socket | null = null
  let waiting: (() => void)[] = []
  const hold = async (conn: Socket) => {
    while (owner && owner !== conn) await new Promise<void>((wake) => waiting.push(wake))
    owner = conn
  }
  const free = async (conn: Socket, rollback = false) => {
    if (owner !== conn) return
    if (rollback) {
      await pg.runExclusive(async () => {
        for (const step of RESET) await pg.execProtocolRaw(step)
      })
    }
    owner = null
    const woken = waiting
    waiting = []
    for (const wake of woken) wake()
  }

  // node:net, not Bun.listen: its socket buffers a write the kernel takes in part.
  const server = createServer((conn) => {
    let buffer = Buffer.alloc(0)
    let started = false
    let chain = Promise.resolve()
    const run = (type: string, message: Buffer) => {
      chain = chain
        .then(async () => {
          if (conn.destroyed) return
          if (type === "X") {
            await free(conn, true)
            conn.end()
            return
          }
          await hold(conn)
          await pg.runExclusive(() =>
            pg.execProtocolRawStream(new Uint8Array(message), {
              onRawData: (data) => {
                if (!conn.destroyed) conn.write(data)
              },
            }),
          )
          if ((type === "startup" || type === "S" || type === "Q") && !pg.isInTransaction()) {
            await free(conn)
          }
        })
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error))
          conn.destroy()
        })
    }
    conn.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return
          const length = buffer.readInt32BE(0)
          if (length < 8 || length > MAX_MESSAGE) return void conn.destroy()
          if (buffer.length < length) return
          const code = buffer.readInt32BE(4)
          const message = buffer.subarray(0, length)
          buffer = buffer.subarray(length)
          if (code === SSL_REQUEST || code === GSS_REQUEST) conn.write("N")
          else if (code === CANCEL_REQUEST) return void conn.end()
          else {
            started = true
            run("startup", message)
          }
          continue
        }
        if (buffer.length < 5) return
        const length = 1 + buffer.readInt32BE(1)
        if (length < 5 || length > MAX_MESSAGE) return void conn.destroy()
        if (buffer.length < length) return
        run(String.fromCharCode(buffer[0]!), buffer.subarray(0, length))
        buffer = buffer.subarray(length)
      }
    })
    conn.on("error", () => {})
    conn.on("close", () => {
      chain = chain.then(() => free(conn, true))
    })
  })

  const stop = async () => {
    server.close()
    await pg.close()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  server.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })
  server.listen(readRecord(home)?.port ?? 0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo
    writeFileSync(join(home, "server.json"), JSON.stringify({ pid: process.pid, port }))
    console.log(`pglite: ${home} on 127.0.0.1:${port}`)
  })
}
