import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { kindOfName } from "../../../../../packages/config/src/kinds"
import {
  launchOf,
  screenOf,
  stepOf,
  typedOf,
} from "../../../../../packages/scripts/src/new-user-gate/claude"

const SCRIPT = join(import.meta.dir, "../../../../../packages/scripts/src/new-user-gate/claude.ts")
const box = realpathSync(mkdtempSync(join(tmpdir(), "gate-claude-")))
afterAll(() => rmSync(box, { force: true, recursive: true }))

describe("launchOf", () => {
  test("reads spawn.sh's launch: the session id, name, model and the prompt after its flags", () => {
    expect(
      launchOf([
        "--session-id",
        "11111111-1111-4111-8111-000000000001",
        "-n",
        "dispatcher",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--settings",
        "/s.json",
        "--dangerously-skip-permissions",
        "--plugin-dir",
        "/p",
        "You are dispatcher.",
      ]),
    ).toEqual({
      model: "claude-opus-5-5",
      name: "dispatcher",
      prompt: "You are dispatcher.",
      sessionId: "11111111-1111-4111-8111-000000000001",
    })
  })

  test("reads a call with no name as no session to keep", () => {
    expect(launchOf(["--version"]).name).toBe("")
  })
})

describe("screenOf", () => {
  test("draws an empty input box between two rules, then the bypass mark spawn.sh waits on", () => {
    const lines = screenOf(["> hello"], 20).replace("\x1b[2J\x1b[H", "").split("\r\n")
    expect(lines).toEqual([
      "> hello",
      "─".repeat(19),
      "❯ ",
      "─".repeat(19),
      "  ⏵⏵ bypass permissions on",
    ])
  })
})

describe("typedOf", () => {
  test("submits a bracketed paste on its Enter and holds what has no Enter yet", () => {
    expect(typedOf("", "\x1b[200~Add a line\x1b[201~\r")).toEqual({
      held: "",
      sent: ["Add a line"],
    })
    expect(typedOf("", "Add a")).toEqual({ held: "Add a", sent: [] })
    expect(typedOf("Add a", " line\r")).toEqual({ held: "", sent: ["Add a line"] })
  })
})

describe("stepOf", () => {
  const at = { data: "/d", repo: "/r" }
  test("the dispatcher starts the builder on a typed message alone", () => {
    expect(stepOf("dispatcher", { ...at, typed: false })).toBeNull()
    expect(stepOf("dispatcher", { ...at, typed: true })).toEqual([
      "bun",
      "/r/packages/scripts/src/playground/cli.ts",
      "builder",
    ])
  })

  test("the builder names its worker so spawn.sh reads its kind from the name", () => {
    expect(kindOfName(stepOf("lead", { ...at, typed: false })![3]!)).toBe("worker")
  })

  // spawn.sh refuses a worker with no --account once usage.accounts lists a Claude row, which first run's Add writes before Alpha starts
  test("the builder names the Claude account first run added on its worker's start", () => {
    expect(stepOf("lead", { ...at, account: "gate@example.com", typed: false })).toEqual([
      "bash",
      "/r/scripts/spawn.sh",
      "worker",
      "g8tw7k-worker",
      "handoffs/gate-task.md",
      "--title",
      "the routed task",
      "--account",
      "gate@example.com",
    ])
  })

  test("the builder starts a worker on the handed task, and the worker opens its PR", () => {
    expect(stepOf("lead", { ...at, typed: false })).toEqual([
      "bash",
      "/r/scripts/spawn.sh",
      "worker",
      "g8tw7k-worker",
      "handoffs/gate-task.md",
      "--title",
      "the routed task",
    ])
    expect(stepOf("worker", { ...at, typed: false })).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "the routed task",
      "--body-file",
      "/d/handoffs/gate-task.md",
    ])
  })
})

// The scripted session run as the box runs it, with a made-up repo whose playground CLI logs its words, and a gh that logs its own.
const run = (role: string, name: string) => {
  const home = join(box, role)
  const repo = join(home, "repo")
  const bin = join(home, "bin")
  mkdirSync(join(repo, "packages", "scripts", "src", "playground"), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(repo, "packages", "scripts", "src", "playground", "cli.ts"),
    `await Bun.write("${home}/cli.log", process.argv.slice(2).join(" "))\n`,
  )
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> "${home}/calls.log"\n`)
  chmodSync(join(bin, "gh"), 0o755)
  const child = Bun.spawn(
    ["bun", SCRIPT, "--session-id", `${role}-id`, "-n", name, "--model", "m", "You are it."],
    {
      cwd: repo,
      env: {
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        PLAYGROUND_REPO: repo,
        PLAYGROUND_ROLE: role,
      },
      stdin: "pipe",
      stdout: "pipe",
    },
  )
  return { child, home, repo }
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(100)
  return ok()
}

describe("the scripted session", () => {
  test("registers at its pid and keeps a transcript while it runs, and removes its registry file when signalled", async () => {
    const { child, home, repo } = run("dispatcher", "dispatcher")
    const registry = join(home, ".claude", "sessions", `${child.pid}.json`)
    expect(await until(() => existsSync(registry))).toBe(true)
    expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
      cwd: repo,
      name: "dispatcher",
      pid: child.pid,
      sessionId: "dispatcher-id",
    })
    const projects = join(home, ".claude", "projects")
    const [project] = readdirSync(projects)
    expect(project).toBe(repo.replace(/[^a-zA-Z0-9]/g, "-"))
    const transcript = join(projects, project!, "dispatcher-id.jsonl")
    child.stdin.write("\x1b[200~Add a line to the README saying hello\x1b[201~\r")
    child.stdin.flush()
    expect(await until(() => existsSync(join(home, "cli.log")))).toBe(true)
    expect(readFileSync(join(home, "cli.log"), "utf8")).toBe("builder")
    expect(readFileSync(join(home, ".playground", "handoffs", "gate-task.md"), "utf8")).toBe(
      "Add a line to the README saying hello\n",
    )
    const said = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "user")
      .map((entry) => entry.message.content)
    expect(said).toEqual(["You are it.", "Add a line to the README saying hello"])
    child.kill()
    await child.exited
    expect(existsSync(registry)).toBe(false)
  })

  test("a worker opens its PR through gh as it starts", async () => {
    const { child, home } = run("worker", "gate-worker")
    expect(await until(() => existsSync(join(home, "calls.log")))).toBe(true)
    expect(readFileSync(join(home, "calls.log"), "utf8")).toContain(
      "gh pr create --title the routed task",
    )
    child.kill()
    await child.exited
  })
})
