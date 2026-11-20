import { readFileSync } from "node:fs"
import { join } from "node:path"

import { keychainServiceOf, loginOf, settingRows, settingsFor } from "@packages/settings"

import { accountOf, claudeConfigFile } from "@/lib/dashboard/account"
import { readsLive } from "@/lib/dashboard/fixture"
import { dataDir } from "@/lib/sessions/paths"

// How old ops-usage's stored-login reading may be, in minutes, before it reads as stale: spawn.sh's limit for the same file.
export const STORED_LIMIT_MINUTES = 15

const STORED = "ops/usage/stored-login.json"
const STATUS = "ops/usage/stored-login-status.json"

// The stored login as ops-usage last read it: live while stored-login.json names the login and is fresh, else stale, empty or ended with spawn.sh's words for it, ended when stored-login-status.json, fresh, gives a loginEnded reason.
export type StoredLogin = { state: "live" } | { cause: string; state: "empty" | "ended" | "stale" }

const parse = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const minutesSince = (at: unknown, now: number): number | null => {
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN
  return Number.isNaN(ms) ? null : Math.floor((now - ms) / 60_000)
}

// Pure: the stored login's state from the two files' text (null for a missing file), for the login the config names.
export function storedLoginOf(
  email: string,
  storedText: string | null,
  statusText: string | null,
  now: number,
): StoredLogin {
  const status = parse(statusText)
  const statusAge = minutesSince(status?.writtenAt, now)
  const ended = status?.loginEnded
  if (typeof ended === "string" && ended && statusAge !== null && statusAge < STORED_LIMIT_MINUTES)
    return { cause: `its Claude Code login has ended (loginEnded: ${ended})`, state: "ended" }
  if (storedText === null)
    return { cause: `it cannot read ${STORED} (no such file)`, state: "empty" }
  const stored = parse(storedText)
  if (!stored) return { cause: `it cannot read ${STORED} (does not read)`, state: "empty" }
  const named = stored.account
  if (typeof named !== "string" || named.toLowerCase() !== email.toLowerCase())
    return {
      cause: `${STORED} reads ${typeof named === "string" && named ? named : "no account"}, not ${email}, the login a start with no --account runs on`,
      state: "empty",
    }
  const age = minutesSince(stored.writtenAt, now)
  if (age === null || age >= STORED_LIMIT_MINUTES)
    return {
      cause: `${STORED} was written ${age ?? "an unknown number of"} minutes ago (writtenAt), ${STORED_LIMIT_MINUTES} is its limit.`,
      state: "stale",
    }
  return { state: "live" }
}

// The login the hosted session starts on: the stored one (no token) while it reads live, else the own account's kept seat token; cause is set when the stored login has ended and no seat token is kept, the words spawn.sh refuses with.
export type HostedLogin = { cause?: string; email?: string; token?: string }

export type SeatIo = {
  config: () => string | null
  now: () => number
  read: (path: string) => string | null
  // The seat token under service for email, or null when the Keychain keeps none; the token goes nowhere but the return.
  seat: (service: string, email: string) => string | null
  // usage.keychainService as the login's settings set it, or null before playground ext init names a login.
  service: () => string | null
}

// Which login the hosted session starts on, by spawn.sh's own rule: the stored login while ops-usage reads it, else the seat token usage.keychainService keeps for the config's account.
export function hostedLogin(io: SeatIo, data: string): HostedLogin {
  const email = accountOf(io.config() ?? "")?.email
  if (!email) return {}
  const stored = storedLoginOf(
    email,
    io.read(join(data, STORED)),
    io.read(join(data, STATUS)),
    io.now(),
  )
  if (stored.state === "live") return {}
  const service = io.service()
  const token = service === null ? null : io.seat(service, email)
  if (token) return { email, token }
  if (stored.state !== "ended") return {}
  return {
    cause: `${stored.cause}, and the Keychain holds no ${service ?? "usage.keychainService"} item for it to start on. The owner's /login in Claude Code brings the login back, and \`playground accounts add\` keeps a seat token for it`,
    email,
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

// usage.keychainService as the login's settings in this data folder set it, never a default of this file's own; null before playground ext init names a login.
export const seatService = (data: string): string | null => {
  try {
    return keychainServiceOf(settingsFor(settingRows(data), loginOf(data)), "claude")
  } catch {
    return null
  }
}

// How long the Keychain read may take before it reads as no token, since the hosted session's start waits on it.
export const SEAT_READ_MS = 5_000

export const seatIo: SeatIo = {
  config: () => readText(claudeConfigFile()),
  now: Date.now,
  read: readText,
  // Bun throws when no security is on PATH (a machine with no Keychain), which reads as no token
  seat: (service, email) => {
    try {
      const run = Bun.spawnSync(
        ["security", "find-generic-password", "-s", service, "-a", email, "-w"],
        {
          // PATH as it reads now, which Bun would otherwise take from the start
          env: process.env,
          stderr: "ignore",
          stdin: "ignore",
          stdout: "pipe",
          timeout: SEAT_READ_MS,
        },
      )
      const token = run.exitCode === 0 ? run.stdout.toString().trim() : ""
      return token || null
    } catch {
      return null
    }
  },
  service: () => seatService(dataDir()),
}

// The login for this machine's hosted session; a stack that reads a fixture keeps today's start on the stored login, so it never reaches the real Keychain.
export const machineHostedLogin = (
  io: SeatIo = seatIo,
  data: string = dataDir(),
  live: () => boolean = readsLive,
): HostedLogin => (live() ? hostedLogin(io, data) : {})
