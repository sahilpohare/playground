import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer, type Socket } from "node:net"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { dataDirOf } from "@packages/env/data-dir"

// A database with no Docker: PGlite (Postgres compiled to WebAssembly) kept in the data folder's pglite/<name>/data and served on 127.0.0.1 by one detached process, so the API and every CLI reach it by a plain POSTGRES_URL as they reach a container. Its URL turns prepared statements off, since every client shares PGlite's one session and two clients' statement names would collide.

export type Record = { home: string; name: string; pid: number; port: number }

const SERVER = join(import.meta.dir, "../bin/pglite.ts")
const START_TRIES = 60

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const CANCEL_REQUEST = 80877102

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
  const running = readRecord(home)
  if (running && alive(running.pid)) return urlOf(running.port)
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
    if (child.exitCode !== null) break
    await wait(500)
  }
  const said = readFileSync(join(home, "server.log"), "utf8").trim().split("\n").at(-1)
  throw new Error(`PGlite in ${home} did not start${said ? `: ${said}` : ""}`)
}

// Restarts the PGlite a URL names when its server has stopped (after a reboot), as `docker start` would its container; a URL no PGlite record names is left alone.
export async function ensurePglite(url: string, root?: string): Promise<void> {
  if (!URL.canParse(url)) return
  const port = Number(new URL(url).port || 5432)
  const record = records(root).find((r) => r.port === port)
  if (record && !alive(record.pid)) await startPglite(record.name, { root })
}

// The server: PGlite has one session, so a connection holds it from its first message to its Sync or simple Query, and for as long as a transaction it opened stays open; no other client's message lands inside its statement or its transaction.
export async function serve(home: string): Promise<void> {
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
          if (length < 8) return void conn.destroy()
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
        if (length < 5) return void conn.destroy()
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
