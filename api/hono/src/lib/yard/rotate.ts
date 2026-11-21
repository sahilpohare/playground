import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

import { hideSecrets } from "@packages/settings"

import { YardError } from "./client"
import { tokenPrefix, tokenSecret } from "./secret"

// The Mac swaps its own Yard token for a fresh one once a day, with no step from the owner: a check every 10 minutes, which also keeps a token an earlier swap left pending.
export const ROTATE_CHECK_MS = 600_000
export const ROTATE_DUE_MS = 86_400_000

type Item = { read: () => Promise<string | null>; write: (value: string) => Promise<void> }

export type RotateDeps = {
  // the hosted Yard's client for a token: yardClient
  client: (token: string) => {
    me: () => Promise<unknown>
    swapToken: (secret: string) => Promise<unknown>
  }
  // the Mac's one token, whose write deletes the pending one after it (keychain())
  keychain: Item
  // the new token from before the swap's call until it is saved (pendingKeychain())
  pending: Item & { remove: () => Promise<void> }
  // the relay's next socket, on the token the Keychain holds now (startRelay's renew)
  renew: () => void
}

// Whether Yard takes a token: its 401 says no, and any other failure, the network's, is thrown.
const works = async (client: RotateDeps["client"], token: string): Promise<boolean> => {
  try {
    await client(token).me()
    return true
  } catch (error) {
    if (error instanceof YardError && error.status === 401) return false
    throw error
  }
}

// One swap of the Mac's token, so the Mac always keeps a token that works: a token an earlier swap left pending is kept first when Yard takes it; then the new one is saved as pending before the call, a lost answer is settled by checking the new one, and the new one is saved over the old one last. Throws why a swap failed, the old token still in place unless the new one is pending.
export async function rotate({
  client,
  keychain,
  pending,
  renew,
}: RotateDeps): Promise<"kept" | "none" | "swapped"> {
  const old = await keychain.read()
  if (!old) return "none"
  const left = await pending.read()
  if (left && left !== old) {
    if (await works(client, left)) {
      await keychain.write(left)
      renew()
      return "kept"
    }
    await pending.remove()
  }
  const next = tokenSecret(tokenPrefix(old))
  await pending.write(next)
  try {
    await client(old).swapToken(next)
  } catch (error) {
    // Yard answered with a refusal, so nothing swapped
    if (error instanceof YardError && error.status < 500) {
      await pending.remove()
      throw error
    }
    if (!(await works(client, next))) {
      await pending.remove()
      throw new Error(`Yard did not swap it (${error instanceof Error ? error.message : error})`)
    }
  }
  await keychain.write(next)
  renew()
  return "swapped"
}

// When the last try ran, from its stamp file, or null with none, and whether Ops has its line for the failing tries since the last swap that went through.
const lastTry = async (stamp: string): Promise<{ alerted: boolean; at: number | null }> => {
  try {
    const read = await Bun.file(stamp).json()
    const at = Date.parse(read.at)
    return { alerted: read.alerted === true, at: Number.isNaN(at) ? null : at }
  } catch {
    return { alerted: false, at: null }
  }
}

// Swaps the Mac's token while the API runs: at start and at each check, once the stamp's last try is ROTATE_DUE_MS old or none is stamped, or a token waits pending; each try is stamped, and the first of a run of failed tries sends alert why, one line until a swap goes through.
export function startRotation({
  alert,
  checkMs = ROTATE_CHECK_MS,
  now = Date.now,
  stamp,
  ...deps
}: RotateDeps & {
  // a failed swap's line for Ops (outboxAlert)
  alert: (text: string) => Promise<void>
  checkMs?: number
  now?: () => number
  // the file the last swap's time is kept in
  stamp: string
}): () => void {
  let running = false
  const check = async () => {
    if (running) return
    running = true
    try {
      const last = await lastTry(stamp)
      if (last.at !== null && now() - last.at < ROTATE_DUE_MS && !(await deps.pending.read()))
        return
      let alerted = false
      try {
        await rotate(deps)
      } catch (error) {
        if (!last.alerted)
          await alert(
            `The Mac could not swap its Yard token, and keeps trying with no further line until a swap goes through: ${error instanceof Error ? error.message : String(error)}`,
          )
        alerted = true
      }
      const at = new Date(now()).toISOString()
      await Bun.write(stamp, JSON.stringify(alerted ? { alerted, at } : { at }))
    } catch (error) {
      console.error("[yard] the token swap's check failed", error)
    } finally {
      running = false
    }
  }
  void check()
  const timer = setInterval(() => void check(), checkMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

// A failed swap's line for the Ops seat, queued in the ops outbox, which the relay sends with SendMessage, its secrets hidden; never a line to the owner.
export const outboxAlert =
  (dir: string, now = () => new Date()) =>
  async (text: string): Promise<void> => {
    const outbox = join(dir, "ops", "outbox")
    await mkdir(outbox, { recursive: true })
    const at = now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
    const line = { at, job: "yard-rotate", text: hideSecrets(text), to: "ops" }
    await appendFile(join(outbox, "ops-yard-rotate.jsonl"), `${JSON.stringify(line)}\n`)
  }
