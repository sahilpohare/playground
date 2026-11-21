import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  hostedLogin,
  machineHostedLogin,
  type SeatIo,
  seatIo,
  seatService,
  storedLoginOf,
} from "../../../../../../api/hono/src/lib/dashboard/seat-login"

const NOW = Date.parse("2026-11-19T12:00:00Z")
const EMAIL = "owner@example.test"
const TOKEN = `made-up-seat-${crypto.randomUUID()}`
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const stored = (minutes: number, account = EMAIL) =>
  JSON.stringify({ account, rate_limits: {}, writtenAt: ago(minutes) })
const status = (minutes: number, loginEnded: string | null) =>
  JSON.stringify({ loginEnded, writtenAt: ago(minutes) })
const CONFIG = JSON.stringify({ oauthAccount: { emailAddress: EMAIL } })

describe("storedLoginOf", () => {
  test("a fresh reading of the config's login is live", () => {
    expect(storedLoginOf(EMAIL, stored(5), null, NOW)).toEqual({ state: "live" })
  })

  test("a reading 15 minutes old or more is stale, in spawn.sh's words", () => {
    expect(storedLoginOf(EMAIL, stored(15), null, NOW)).toEqual({
      cause: "ops/usage/stored-login.json was written 15 minutes ago (writtenAt), 15 is its limit.",
      state: "stale",
    })
  })

  test("a missing file, one that does not read, or one naming another account, is empty, in spawn.sh's load() words", () => {
    expect(storedLoginOf(EMAIL, null, null, NOW)).toEqual({
      cause: "it cannot read ops/usage/stored-login.json (no such file)",
      state: "empty",
    })
    expect(storedLoginOf(EMAIL, "{", null, NOW)).toEqual({
      cause: "it cannot read ops/usage/stored-login.json (does not read)",
      state: "empty",
    })
    expect(storedLoginOf(EMAIL, stored(5, "other@example.test"), null, NOW)).toEqual({
      cause: `ops/usage/stored-login.json reads other@example.test, not ${EMAIL}, the login a start with no --account runs on`,
      state: "empty",
    })
  })

  test("a fresh status naming a loginEnded reason is ended, whatever the reading", () => {
    expect(storedLoginOf(EMAIL, stored(5), status(2, "time_limit"), NOW)).toEqual({
      cause: "its Claude Code login has ended (loginEnded: time_limit)",
      state: "ended",
    })
  })

  test("a status 15 minutes old or more, or with no reason, leaves the reading to judge", () => {
    expect(storedLoginOf(EMAIL, stored(5), status(15, "time_limit"), NOW)).toEqual({
      state: "live",
    })
    expect(storedLoginOf(EMAIL, stored(5), status(2, null), NOW)).toEqual({ state: "live" })
  })
})

describe("hostedLogin", () => {
  const io = (
    files: Record<string, string>,
    seat: string | null,
    asked: [string, string][] = [],
  ): SeatIo => ({
    config: () => CONFIG,
    now: () => NOW,
    read: (path) => files[path] ?? null,
    seat: (service, email) => {
      asked.push([service, email])
      return seat
    },
    service: () => "acme-claude",
  })
  const at = (data: string, name: string) => join(data, "ops", "usage", name)

  test("an ended stored login with a kept seat token starts on that token, read under the setting's service for the config's account", () => {
    const asked: [string, string][] = []
    const files = {
      [at("/data", "stored-login-status.json")]: status(2, "time_limit"),
      [at("/data", "stored-login.json")]: stored(600),
    }
    expect(hostedLogin(io(files, TOKEN, asked), "/data")).toEqual({ email: EMAIL, token: TOKEN })
    expect(asked).toEqual([["acme-claude", EMAIL]])
  })

  test("a stale or empty stored login with a kept seat token starts on it too", () => {
    expect(
      hostedLogin(io({ [at("/data", "stored-login.json")]: stored(600) }, TOKEN), "/data"),
    ).toEqual({ email: EMAIL, token: TOKEN })
    expect(hostedLogin(io({}, TOKEN), "/data")).toEqual({ email: EMAIL, token: TOKEN })
  })

  test("a live stored login keeps today's start, and the Keychain is never read", () => {
    const asked: [string, string][] = []
    expect(
      hostedLogin(io({ [at("/data", "stored-login.json")]: stored(5) }, TOKEN, asked), "/data"),
    ).toEqual({})
    expect(asked).toEqual([])
  })

  test("an ended stored login with no seat token gives the ended cause, in spawn.sh's words", () => {
    expect(
      hostedLogin(
        io({ [at("/data", "stored-login-status.json")]: status(2, "time_limit") }, null),
        "/data",
      ),
    ).toEqual({
      cause:
        "its Claude Code login has ended (loginEnded: time_limit), and the Keychain holds no acme-claude item for it to start on. The owner's /login in Claude Code brings the login back, and `playground accounts add` keeps a seat token for it",
      email: EMAIL,
    })
  })

  test("a stale or empty stored login that has not ended, with no seat token, keeps today's start with no cause, since the hosted session has no usage gate", () => {
    expect(
      hostedLogin(io({ [at("/data", "stored-login.json")]: stored(600) }, null), "/data"),
    ).toEqual({})
    expect(hostedLogin(io({}, null), "/data")).toEqual({})
  })

  test("a stack that reads a fixture keeps today's start, and the Keychain is never read", () => {
    const asked: [string, string][] = []
    expect(machineHostedLogin(io({}, TOKEN, asked), "/data", () => false)).toEqual({})
    expect(asked).toEqual([])
    expect(machineHostedLogin(io({}, TOKEN), "/data", () => true)).toEqual({
      email: EMAIL,
      token: TOKEN,
    })
  })

  test("a config that names no account keeps today's start", () => {
    expect(hostedLogin({ ...io({}, TOKEN), config: () => null }, "/data")).toEqual({})
  })
})

describe("the machine's seat reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-login-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "security"),
    `#!/bin/sh
[ "$*" = "find-generic-password -s acme-claude -a ${EMAIL} -w" ] && { printf '%s\\n' "${TOKEN}"; exit 0; }
exit 44
`,
  )
  chmodSync(join(bin, "security"), 0o755)
  const path = process.env.PATH
  beforeAll(() => {
    process.env.PATH = `${bin}:${path}`
  })
  afterAll(() => {
    process.env.PATH = path
    rmSync(dir, { force: true, recursive: true })
  })

  test("the seat token comes from security's own answer for the service and account, and none when it keeps no item", () => {
    expect(seatIo.seat("acme-claude", EMAIL)).toBe(TOKEN)
    expect(seatIo.seat("playground-claude-oauth", EMAIL)).toBeNull()
  })

  test("a machine with no security on PATH reads no seat token, rather than throw", () => {
    const now = process.env.PATH
    process.env.PATH = join(dir, "empty")
    try {
      expect(seatIo.seat("acme-claude", EMAIL)).toBeNull()
    } finally {
      process.env.PATH = now
    }
  })

  test("the service is the login's usage.keychainService setting, and none before a login is named", () => {
    const data = join(dir, "data")
    expect(seatService(data)).toBeNull()
    mkdirSync(join(data, "extensions", "me", ".git"), { recursive: true })
    writeFileSync(join(data, "extensions", "login"), "me\n")
    writeFileSync(
      join(data, "extensions", "me", "settings.json"),
      JSON.stringify({ "usage.keychainService": "acme-claude" }),
    )
    expect(seatService(data)).toBe("acme-claude")
  })
})
