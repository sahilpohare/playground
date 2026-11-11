import { afterAll, describe, expect, test } from "bun:test"
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

const stop = async (pid: number) => {
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

  test("ensurePglite leaves alone a URL no PGlite record names", async () => {
    await ensurePglite("postgres://postgres@127.0.0.1:1/postgres", root)
    await ensurePglite("not a url", root)
    expect(mine()).toHaveLength(1)
  })
})
