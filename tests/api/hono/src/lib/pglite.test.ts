import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"

import { SQL } from "bun"

import {
  ensurePglite,
  identifierOf,
  pgliteRoot,
  records,
  servingPort,
  startPglite,
  urlOf,
} from "../../../../../api/hono/src/lib/pglite"
import { type Docker, provenLocal } from "../../../../../api/hono/src/lib/sessions/guard"

// The sandbox HOME's own data folder, which the guard reads by default; the name is this run's alone.
const root = pgliteRoot()
const name = `pglite-test-${process.pid}`
const mine = () => records(root).filter((record) => record.name === name)
// A pid no process can hold, so alive() reads it gone.
const GONE = 2 ** 30
const home = () => join(root, name)

const stop = async (pid: number) => {
  if (pid === process.pid) return
  process.kill(pid, "SIGTERM")
  for (let tries = 0; tries < 50; tries++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(100)
  }
}

afterAll(async () => {
  for (const { pid } of mine()) await stop(pid).catch(() => {})
})

const frame = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(5)
  head.write(type, 0)
  head.writeInt32BE(4 + body.length, 1)
  return Buffer.concat([head, body])
}
const cstr = (text: string) => Buffer.from(`${text}\0`)
const int16 = (n: number) => Buffer.from([n >> 8, n & 255])

// A raw client that sends Parse, Bind, Execute and Flush with no Sync, waits for the statement's own reply, then drops its connection.
const dropMidStatement = (url: string, query: string, reply: string) =>
  new Promise<void>((done, fail) => {
    const socket = connect(Number(new URL(url).port), "127.0.0.1")
    const startup = Buffer.concat([
      cstr("user"),
      cstr("postgres"),
      cstr("database"),
      cstr("postgres"),
      Buffer.from([0]),
    ])
    const head = Buffer.alloc(8)
    head.writeInt32BE(8 + startup.length, 0)
    head.writeInt32BE(196608, 4)
    let seen = ""
    let sent = false
    socket.on("error", fail)
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1")
      if (!sent && seen.includes("Z\0\0\0\x05I")) {
        sent = true
        seen = ""
        socket.write(
          Buffer.concat([
            frame("P", cstr(""), cstr(query), int16(0)),
            frame("B", cstr(""), cstr(""), int16(0), int16(0), int16(0)),
            frame("E", cstr(""), Buffer.alloc(4)),
            frame("H"),
          ]),
        )
      } else if (sent && seen.includes(reply)) {
        socket.destroy()
        done()
      }
    })
    socket.write(Buffer.concat([head, startup]))
  })

const noDocker: Docker = () => {
  throw new Error("docker was called for a PGlite database")
}

describe("a PGlite database", () => {
  let url = ""

  test("starts detached on loopback, recorded under its name, with prepared statements off", async () => {
    url = await startPglite(name, { root })
    expect(url).toMatch(/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?prepare=false$/)
    const port = Number(new URL(url).port)
    expect(url).toBe(urlOf(port))
    expect(servingPort(port, root)).toMatchObject({ home: join(root, name), name: name })
    expect(await startPglite(name, { root })).toBe(url)
  }, 60_000)

  test("serves many clients at once with no query reading another's result", async () => {
    const a = new SQL(url, { max: 8 })
    const b = new SQL(url, { max: 4 })
    try {
      const rows = await Promise.all(
        Array.from(
          { length: 200 },
          (_, i) => (i % 3 ? a : b)`select ${i}::int as n, ${`k${i}`}::text as k`,
        ),
      )
      expect(rows.filter((r, i) => r[0]?.n !== i || r[0]?.k !== `k${i}`)).toEqual([])
    } finally {
      await a.close()
      await b.close()
    }
  }, 30_000)

  test("keeps a transaction to the client that opened it, and rolls back a failed one", async () => {
    const sql = new SQL(url, { max: 6 })
    try {
      await sql`create table tx_probe (id serial primary key, v text)`
      const kept = sql.begin(async (t) => {
        await t`insert into tx_probe (v) values ('first')`
        await Bun.sleep(150)
        await t`insert into tx_probe (v) values ('second')`
      })
      const failed = sql
        .begin(async (t) => {
          await t`insert into tx_probe (v) values ('dropped')`
          throw new Error("roll back")
        })
        .catch((error: Error) => error.message)
      const reads = await Promise.all(
        Array.from({ length: 30 }, () => sql`select count(*)::int as n from tx_probe`),
      )
      await kept
      expect(await failed).toBe("roll back")
      expect(reads.every(([row]) => row.n === 0 || row.n === 2)).toBe(true)
      const [row] = await sql`select string_agg(v, ',' order by id) as v from tx_probe`
      expect(row.v).toBe("first,second")
    } finally {
      await sql.close()
    }
  }, 30_000)

  test("is proved local by the identifier in its own pg_control, with no Docker", async () => {
    const proof = await provenLocal(url, noDocker)
    expect(proof).toContain(`is ${name} (pglite)`)
    const sql = new SQL(url, { max: 1 })
    try {
      const [row] = await sql`select system_identifier::text as id from pg_control_system()`
      expect(row.id).toBe(identifierOf(join(root, name)))
    } finally {
      await sql.close()
    }
  }, 30_000)

  test("comes back on the same URL with its data after it stops", async () => {
    const [record] = mine()
    await stop(record!.pid)
    expect(servingPort(record!.port, root)).toBeUndefined()
    await ensurePglite(url, root)
    expect(servingPort(record!.port, root)?.pid).not.toBe(record!.pid)
    const sql = new SQL(url, { max: 1 })
    try {
      const [row] = await sql`select count(*)::int as n from tx_probe`
      expect(row.n).toBe(2)
    } finally {
      await sql.close()
    }
  }, 60_000)

  test("undoes a client that drops mid-statement, written or failed, so the next one starts clean", async () => {
    await dropMidStatement(url, "insert into tx_probe (v) values ('orphan')", "C")
    await dropMidStatement(url, "select 1/0", "E")
    const sql = new SQL(url, { max: 1 })
    try {
      const [row] = await sql`select count(*)::int as n from tx_probe where v = 'orphan'`
      expect(row.n).toBe(0)
    } finally {
      await sql.close()
    }
  }, 30_000)

  test("revives a server whose recorded pid another process took after a reboot", async () => {
    const [record] = mine()
    await stop(record!.pid)
    writeFileSync(
      join(home(), "server.json"),
      JSON.stringify({ pid: process.pid, port: record!.port }),
    )
    await ensurePglite(url, root)
    const revived = servingPort(record!.port, root)
    expect(revived?.pid).not.toBe(process.pid)
    expect(revived?.pid).not.toBe(record!.pid)
  }, 60_000)

  test("refuses a second server on a data folder a live one holds, and takes over a stale lock", async () => {
    const [record] = mine()
    await stop(record!.pid)
    writeFileSync(join(home(), "server.lock"), String(process.pid))
    await expect(startPglite(name, { root, wait: () => Bun.sleep(50) })).rejects.toThrow(
      "already served",
    )
    expect(servingPort(record!.port, root)).toBeUndefined()
    writeFileSync(join(home(), "server.lock"), String(GONE))
    await ensurePglite(url, root)
    expect(servingPort(record!.port, root)?.pid).not.toBe(record!.pid)
  }, 60_000)

  test("runs one server for two starts racing on one name", async () => {
    const [record] = mine()
    await stop(record!.pid)
    const [a, b] = await Promise.all([startPglite(name, { root }), startPglite(name, { root })])
    expect(a).toBe(b)
    expect(a).toBe(url)
    const sql = new SQL(url, { max: 1 })
    try {
      const [row] = await sql`select count(*)::int as n from tx_probe`
      expect(row.n).toBe(2)
    } finally {
      await sql.close()
    }
  }, 60_000)

  test("ensurePglite refuses a port two records name, since either could be a stale checkout's", async () => {
    const twins = [`${name}-a`, `${name}-b`].map((twin) => join(root, twin))
    try {
      for (const twin of twins) {
        mkdirSync(twin, { recursive: true })
        writeFileSync(join(twin, "server.json"), JSON.stringify({ pid: GONE, port: 2 }))
      }
      await expect(ensurePglite(urlOf(2), root)).rejects.toThrow("both record port 2")
    } finally {
      for (const twin of twins) rmSync(twin, { force: true, recursive: true })
    }
  })

  test("drops a connection whose message claims more than 1 GB", async () => {
    const socket = connect(Number(new URL(url).port), "127.0.0.1")
    const head = Buffer.alloc(8)
    head.writeInt32BE(2 ** 30 + 1, 0)
    head.writeInt32BE(196608, 4)
    await new Promise((done) => socket.once("connect", done))
    const closed = new Promise<void>((done) => socket.on("close", () => done()))
    socket.write(head)
    await closed
  })

  test("ensurePglite leaves alone a URL no PGlite record names", async () => {
    await ensurePglite("postgres://postgres@127.0.0.1:1/postgres", root)
    await ensurePglite("not a url", root)
    expect(mine()).toHaveLength(1)
  })
})
