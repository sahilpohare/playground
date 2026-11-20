import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "scripts",
  "src",
  "security",
  "cli.ts",
)

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A scratch HOME and data folder for each case, so no run reaches a real secret; every value below is made up.
const box = () => {
  const home = mkdtempSync(join(tmpdir(), "security-"))
  dirs.push(home)
  const data = join(home, "data")
  return { data, home, store: join(data, "secrets", "keychain") }
}

const run = (b: { data: string; home: string }, args: string[], input?: string) => {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { HOME: b.home, PATH: process.env.PATH, PLAYGROUND_DATA_DIR: b.data, USER: "someone" },
    stdin: input === undefined ? "ignore" : new Blob([input]),
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
}

const SERVICE = "playground-test-tokens"
const ACCOUNT = "seat@example.test"
const VALUE = "made-up-value-0123456789"
const OTHER = "made-up-value-abcdefghij"
const addLine = (value: string, service = SERVICE, account = ACCOUNT) =>
  `add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`
const mode = (path: string) => statSync(path).mode & 0o777

describe("find-generic-password", () => {
  test("an item that is not there exits 44, as macOS's security does, and prints no value", () => {
    const b = box()
    const found = run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
    expect(found.code).toBe(44)
    expect(found.stdout).toBe("")
    expect(found.stderr).toContain("could not be found")
  })

  test("-w prints a saved item's value on its own line", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    const found = run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
    expect(found).toEqual({ code: 0, stderr: "", stdout: `${VALUE}\n` })
  })

  test("the flags read in any order", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    expect(run(b, ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]).stdout).toBe(
      `${VALUE}\n`,
    )
  })

  test("without -w it exits 0 for a saved item and prints no value", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    const found = run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT])
    expect(found.code).toBe(0)
    expect(found.stdout).not.toContain(VALUE)
  })

  test("another account under the same service is not the item", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    expect(
      run(b, ["find-generic-password", "-s", SERVICE, "-a", "other@example.test", "-w"]).code,
    ).toBe(44)
  })
})

describe("add-generic-password", () => {
  test("-i saves the line's value from stdin as a mode-600 file in 700 folders under the data folder's secrets/keychain", () => {
    const b = box()
    const added = run(b, ["-i"], addLine(VALUE))
    expect(added).toEqual({ code: 0, stderr: "", stdout: "" })
    const [service] = readdirSync(b.store)
    const [account] = readdirSync(join(b.store, service!))
    const file = join(b.store, service!, account!)
    expect(readFileSync(file, "utf8")).toBe(VALUE)
    expect(mode(file)).toBe(0o600)
    for (const folder of [join(b.data, "secrets"), b.store, join(b.store, service!)])
      expect(mode(folder)).toBe(0o700)
  })

  test("-U replaces a saved value, and the file stays at mode 600", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    expect(run(b, ["-i"], addLine(OTHER)).code).toBe(0)
    expect(run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).stdout).toBe(
      `${OTHER}\n`,
    )
    const [service] = readdirSync(b.store)
    const [account, ...rest] = readdirSync(join(b.store, service!))
    expect(rest).toEqual([])
    expect(mode(join(b.store, service!, account!))).toBe(0o600)
  })

  test("without -U an item already there is kept and the add exits 45", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    const again = run(
      b,
      ["-i"],
      `add-generic-password -s "${SERVICE}" -a "${ACCOUNT}" -w "${OTHER}"\n`,
    )
    expect(again.code).toBe(45)
    expect(again.stderr).not.toContain(OTHER)
    expect(run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).stdout).toBe(
      `${VALUE}\n`,
    )
  })

  test("a bare trailing -w reads the value from stdin, so no argv holds it", () => {
    const b = box()
    const added = run(b, ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], `${VALUE}\n`)
    expect(added.code).toBe(0)
    expect(run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).stdout).toBe(
      `${VALUE}\n`,
    )
  })

  test("a service or account of dots stays inside the store", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE, "..", "..")).code).toBe(0)
    expect(readdirSync(b.data)).toEqual(["secrets"])
    expect(readdirSync(join(b.data, "secrets"))).toEqual(["keychain"])
    expect(run(b, ["find-generic-password", "-s", "..", "-a", "..", "-w"]).stdout).toBe(
      `${VALUE}\n`,
    )
  })

  test("a refused -i line names no value in its error", () => {
    const b = box()
    const refused = run(b, ["-i"], `add-generic-password -U -s "${SERVICE}" -w "${VALUE}"\n`)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).not.toBe("")
    expect(refused.stderr).not.toContain(VALUE)
    expect(refused.stdout).not.toContain(VALUE)
  })
})

describe("-i over several lines", () => {
  test("each line runs, each refusal is named, and the exit is the first refusal's", () => {
    const b = box()
    const lines = `add-generic-password -U -s "${SERVICE}" -w "${VALUE}"\n${addLine(VALUE)}delete-generic-password -s "${SERVICE}" -a "nobody"\n`
    const ran = run(b, ["-i"], lines)
    expect(ran.code).toBe(2)
    expect(ran.stderr.trim().split("\n")).toHaveLength(2)
    expect(ran.stderr).not.toContain(VALUE)
    expect(run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).stdout).toBe(
      `${VALUE}\n`,
    )
  })
})

describe("delete-generic-password", () => {
  test("removes a saved item, which then reads as not found", () => {
    const b = box()
    expect(run(b, ["-i"], addLine(VALUE)).code).toBe(0)
    const removed = run(b, ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
    expect(removed.code).toBe(0)
    expect(removed.stdout).not.toContain(VALUE)
    expect(run(b, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).code).toBe(44)
  })

  test("an item that is not there exits 44", () => {
    expect(run(box(), ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).code).toBe(44)
  })
})

// Claude Code keeps its login on Linux in ~/.claude/.credentials.json at mode 600, where macOS keeps it in the Keychain's Claude Code-credentials item.
describe("the Claude Code-credentials item", () => {
  const CREDENTIALS =
    '{"claudeAiOauth":{"accessToken":"made-up-access","refreshToken":"made-up-refresh"}}'

  test("-w reads ~/.claude/.credentials.json, whatever the account", () => {
    const b = box()
    mkdirSync(join(b.home, ".claude"))
    writeFileSync(join(b.home, ".claude", ".credentials.json"), CREDENTIALS, { mode: 0o600 })
    const found = run(b, [
      "find-generic-password",
      "-a",
      "someone",
      "-s",
      "Claude Code-credentials",
      "-w",
    ])
    expect(found.code).toBe(0)
    expect(JSON.parse(found.stdout)).toEqual(JSON.parse(CREDENTIALS))
    expect(existsSync(join(b.data, "secrets"))).toBe(false)
  })

  test("with no ~/.claude/.credentials.json it exits 44", () => {
    expect(
      run(box(), ["find-generic-password", "-a", "someone", "-s", "Claude Code-credentials", "-w"])
        .code,
    ).toBe(44)
  })

  test("an add writes ~/.claude/.credentials.json at mode 600", () => {
    const b = box()
    const added = run(b, ["-i"], addLine("made-up-login", "Claude Code-credentials", "someone"))
    expect(added.code).toBe(0)
    const file = join(b.home, ".claude", ".credentials.json")
    expect(readFileSync(file, "utf8")).toBe("made-up-login")
    expect(mode(file)).toBe(0o600)
  })
})

describe("what it does not serve", () => {
  test("verify-cert and any other subcommand exit 1, naming the four it serves", () => {
    const refused = run(box(), ["verify-cert", "-c", "/nowhere/ca.pem", "-L", "-p", "ssl"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("find-generic-password")
  })
})
