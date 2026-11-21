import { tmpdir } from "node:os"

import { readsLive } from "@/lib/dashboard/fixture"
import type { KeychainRead, KeychainSave, SinkRun } from "@/lib/dashboard/inbox"
import { keychainItem, type Run } from "@/lib/keychain"
import { KEYCHAIN_ITEMS, keychainSpec } from "@/lib/keychain-items"
import { keychain } from "@/lib/yard/keychain"

// A sink that waits on a prompt is stopped after this long, so a Submit never hangs.
const SINK_TIMEOUT_MS = 60_000

// The sink's whole environment: what vercel needs to find itself, its login, a proxy and a custom CA, so the API's own secrets stay out of it.
const PASSED = [
  "ALL_PROXY",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]

export const sinkEnv = (from: Record<string, string | undefined> = process.env) =>
  Object.fromEntries(
    Object.entries(from).flatMap(([key, value]) =>
      value !== undefined && (PASSED.includes(key) || key.startsWith("VERCEL_"))
        ? [[key, value]]
        : [],
    ),
  )

// Runs a secret ask's sink: the value written to its stdin and closed, its output dropped unread, so nothing it prints is kept; its exit code, null once stopped by a signal (its time limit's included), 127 when it could not start. It runs from the temp folder, so no checkout's linked project is read in place of the one its argv names.
export async function spawnSink(
  argv: string[],
  value: string,
  timeout = SINK_TIMEOUT_MS,
): Promise<number | null> {
  let proc: Bun.Subprocess<"pipe", "ignore", "ignore">
  try {
    proc = Bun.spawn(argv, {
      cwd: tmpdir(),
      env: sinkEnv(),
      stderr: "ignore",
      stdin: "pipe",
      stdout: "ignore",
      timeout,
    })
  } catch {
    return 127
  }
  try {
    proc.stdin.write(value)
    await proc.stdin.end()
  } catch {
    // a sink that exits before reading closes the pipe; its own exit code says how it went
  }
  await proc.exited
  return proc.signalCode ? null : proc.exitCode
}

// Only a stack that reads the live machine runs the sink (fixture.ts's dashboardSource), as only it reads the machine's own sessions: a fixture or test stack runs nothing and reads exit 0, so no test reaches a real Vercel project.
export const runSink: SinkRun = (argv, value) =>
  readsLive() ? spawnSink(argv, value) : Promise.resolve(0)

// The item a keychain sink writes: the Mac's one Yard item through keychain(), so a token saved there also deletes the old relay item, and any other item as itself.
export const keychainWriter = (item: string, run?: Run) =>
  keychainSpec(item) === KEYCHAIN_ITEMS.yard ? keychain(run) : keychainItem(item, { run })

// A keychain sink's writer, on the same terms: only a stack that reads the live machine writes this computer's secret store, and any other saves nothing.
export const saveToKeychain: KeychainSave = (item, value) =>
  readsLive() ? keychainWriter(item).write(value) : Promise.resolve()

// The value a fixture or test stack's reveal shows, made up, so no shot or test holds a real one.
export const FIXTURE_REVEAL = "made-up-value-from-the-fixture"

// A reveal card's reader, on the same terms: only a stack that reads the live machine runs `security`, and any other shows FIXTURE_REVEAL; run is a test's stand-in for `security`.
export const readFromKeychain =
  (run?: Run): KeychainRead =>
  (item) =>
    readsLive() ? keychainItem(item, { run }).read() : Promise.resolve(FIXTURE_REVEAL)
