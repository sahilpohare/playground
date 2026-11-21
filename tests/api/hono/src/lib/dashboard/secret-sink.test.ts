import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FIXTURE_REVEAL,
  keychainWriter,
  readFromKeychain,
  runSink,
  sinkEnv,
  spawnSink,
} from "../../../../../../api/hono/src/lib/dashboard/secret-sink"
import type { Run } from "../../../../../../api/hono/src/lib/keychain"

const scratch = mkdtempSync(join(tmpdir(), "secret-sink-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const VALUE = `made-up-secret-${crypto.randomUUID()}`

// A stand-in for vercel: it writes the argv it was given and the stdin it read into files, then exits with the code its first argument names.
const STUB = join(scratch, "stub.ts")
await Bun.write(
  STUB,
  `const [out, code] = process.argv.slice(2)
await Bun.write(out + ".argv", JSON.stringify(process.argv))
await Bun.write(out + ".stdin", await Bun.stdin.text())
process.exit(Number(code))
`,
)

describe("the secret's sink process (PG-59)", () => {
  test("reads the value on its stdin, never in its argv, and its exit code comes back", async () => {
    const out = join(scratch, "one")
    expect(await spawnSink([process.execPath, STUB, out, "3"], VALUE)).toBe(3)
    expect(await Bun.file(`${out}.stdin`).text()).toBe(VALUE)
    expect(await Bun.file(`${out}.argv`).text()).not.toContain(VALUE)
  })

  test("one that cannot start reads 127, and one past its time is stopped and reads null", async () => {
    expect(await spawnSink([join(scratch, "no-such-binary")], VALUE)).toBe(127)
    expect(
      await spawnSink([process.execPath, "-e", "await Bun.sleep(10_000)"], VALUE, 200),
    ).toBeNull()
  })

  test("a stack that does not read the live machine runs no process and reads 0", async () => {
    const out = join(scratch, "fixture")
    expect(await runSink([process.execPath, STUB, out, "1"], VALUE)).toBe(0)
    expect(await Bun.file(`${out}.stdin`).exists()).toBe(false)
  })

  test("gets only what vercel needs from the API's environment, never its secrets", () => {
    const env = sinkEnv({
      BETTER_AUTH_SECRET: "made-up-auth",
      HOME: "/home/someone",
      PATH: "/usr/bin",
      POSTGRES_URL: "postgres://made-up",
      VERCEL_TOKEN: "made-up-token",
    })
    expect(env).toEqual({ HOME: "/home/someone", PATH: "/usr/bin", VERCEL_TOKEN: "made-up-token" })
  })
})

describe("a reveal card's reader (PG-1023)", () => {
  // the test stack reads the fixture, so a reveal there shows a made-up value and never runs `security`, and no test or shot reaches the real Keychain
  test("on a stack that does not read the live machine, runs no `security` and shows the fixture's made-up value", async () => {
    const calls: string[][] = []
    const read = readFromKeychain(async (argv) => {
      calls.push(argv)
      return { code: 0, stderr: "", stdout: "real" }
    })
    expect(await read("playground-glm")).toBe(FIXTURE_REVEAL)
    expect(calls).toEqual([])
  })
})

describe("a keychain sink's writer", () => {
  // a fake `security`, so no test reaches the real Keychain
  const fake = () => {
    const calls: string[][] = []
    const run: Run = async (argv, input) => {
      calls.push(input ? [...argv, input.split(" -a ")[0] ?? ""] : argv.slice(0, 4))
      return { code: 0, stderr: "", stdout: "" }
    }
    return { calls, run }
  }

  test("writes the Mac's one Yard item through the Yard keychain, so the old relay item and a swap's pending one go after it", async () => {
    for (const item of ["yard", "playground-yard"]) {
      const { calls, run } = fake()
      await keychainWriter(item, run).write("yard_made-up-token")
      expect(calls).toEqual([
        ["security", "-i", 'add-generic-password -U -s "playground-yard"'],
        ["security", "delete-generic-password", "-s", "playground-yard-relay"],
        ["security", "delete-generic-password", "-s", "playground-yard-pending"],
      ])
    }
  })

  test("writes any other item as itself", async () => {
    const { calls, run } = fake()
    await keychainWriter("slack", run).write("xoxp-made-up-0000")
    expect(calls).toEqual([["security", "-i", 'add-generic-password -U -s "playground-slack"']])
  })
})
