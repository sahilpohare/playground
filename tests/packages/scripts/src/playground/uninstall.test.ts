import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { ourJobFiles, uninstall } from "../../../../../packages/scripts/src/playground/uninstall"
import type { Run } from "../../../../../packages/scripts/src/playground/update"
import { userSystemctl } from "../../../../../packages/scripts/src/user-systemctl"

const scratch = mkdtempSync(join(tmpdir(), "playground-uninstall-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const write = (path: string, text = "") => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const link = (target: string, path: string) => {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}
// a link's own presence, since existsSync follows it to a target these scratch links never have
const linked = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
const plist = (program: string) =>
  `<plist><dict><key>ProgramArguments</key><array><string>${program}</string></array></dict></plist>\n`

let made = 0
// A scratch install: a checkout, a data folder with a file and a link, a skill and a bin link, our LaunchAgent and someone else's.
const install = () => {
  const root = join(scratch, `install-${++made}`)
  const repo = join(root, "repo")
  const home = join(root, "home")
  const data = join(home, ".playground")
  const agents = join(home, "Library", "LaunchAgents")
  write(join(data, "roster.json"), "{}")
  link(join(repo, "scripts", "ops", "run-slot.sh"), join(data, "ops", "run-slot.sh"))
  link(join(repo, "skills", "pr"), join(home, ".claude", "skills", "pr"))
  link(
    join(repo, "packages", "scripts", "src", "playground", "cli.ts"),
    join(home, ".bun", "bin", "playground"),
  )
  link("/elsewhere/bun", join(home, ".bun", "bin", "bun"))
  write(
    join(agents, "com.playground.ops-tick.plist"),
    plist(`${repo}/.claude/worktrees/dashboard/packages/scripts/src/ops-tick/cli.ts`),
  )
  write(join(agents, "com.playground.ops-awake.plist"), plist(`${data}/ops/awake.sh`))
  write(join(agents, "com.google.keystone.agent.plist"), plist("/Library/Google/keystone"))
  const calls: string[][] = []
  // claude holds the home skill set and its marketplace until uninstall removes them
  const claude = { marketplace: true, plugin: true }
  const run: Run = async (argv) => {
    calls.push(argv)
    const words = argv.slice(1).join(" ")
    if (argv[0] !== "claude") return { code: 0, out: "" }
    if (words === "plugin list") return { code: 0, out: claude.plugin ? "ws-home@ws\n" : "" }
    if (words === "plugin marketplace list --json")
      return { code: 0, out: JSON.stringify(claude.marketplace ? [{ name: "ws" }] : []) }
    if (words === "plugin uninstall ws-home@ws --scope user") claude.plugin = false
    if (words === "plugin marketplace remove ws") claude.marketplace = false
    return { code: 0, out: "" }
  }
  const said: string[] = []
  const base = {
    claude: true,
    data,
    database: "playground-dashboard-db",
    home,
    log: (line: string) => said.push(line),
    platform: "darwin" as const,
    repo,
    run,
    stacks: [join(repo, ".claude", "worktrees", "dashboard")],
  }
  return { agents, base, calls, data, home, repo, said }
}

test("ourJobFiles takes the LaunchAgents that run from the checkout or the data folder, and no other", () => {
  const { agents, data, repo } = install()
  expect(ourJobFiles(agents, repo, data)).toEqual([
    join(agents, "com.playground.ops-awake.plist"),
    join(agents, "com.playground.ops-tick.plist"),
  ])
  expect(ourJobFiles(join(scratch, "no-agents"), repo, data)).toEqual([])
})

describe("uninstall", () => {
  test("removes the LaunchAgents, the stack and the links, and keeps the data folder and the database", async () => {
    const { agents, base, calls, data, home, said } = install()
    expect(await uninstall({ ...base, confirm: async () => true, purge: false })).toBe(0)
    expect(existsSync(join(agents, "com.playground.ops-tick.plist"))).toBe(false)
    expect(existsSync(join(agents, "com.google.keystone.agent.plist"))).toBe(true)
    expect(calls).toContainEqual([
      "launchctl",
      "bootout",
      `gui/${process.getuid!()}`,
      join(agents, "com.playground.ops-tick.plist"),
    ])
    expect(calls).toContainEqual([process.execPath, "run", "--cwd", base.stacks[0]!, "dev:stop"])
    expect(linked(join(home, ".claude", "skills", "pr"))).toBe(false)
    expect(linked(join(data, "ops", "run-slot.sh"))).toBe(false)
    expect(linked(join(home, ".bun", "bin", "bun"))).toBe(true)
    expect(existsSync(join(data, "roster.json"))).toBe(true)
    expect(calls.some((argv) => argv[0] === "docker")).toBe(false)
    expect(said.at(-1)).toContain("--purge")
  })

  test("--purge asks first, and a no removes nothing", async () => {
    const { agents, base, calls, data, home } = install()
    expect(await uninstall({ ...base, confirm: async () => false, purge: true })).toBe(1)
    expect(calls).toEqual([])
    expect(existsSync(join(agents, "com.playground.ops-tick.plist"))).toBe(true)
    expect(linked(join(home, ".claude", "skills", "pr"))).toBe(true)
    expect(existsSync(join(data, "roster.json"))).toBe(true)
  })

  test("--purge with a yes removes the database with its volume and moves the data folder aside", async () => {
    const { base, calls, data, home, said } = install()
    expect(await uninstall({ ...base, confirm: async () => true, purge: true })).toBe(0)
    expect(calls).toContainEqual(["docker", "rm", "-fv", "playground-dashboard-db"])
    expect(existsSync(data)).toBe(false)
    const [aside] = readdirSync(home).filter((name) => name.startsWith(".playground-purged-"))
    expect(aside).toMatch(/^\.playground-purged-\d{8}T\d{6}Z$/)
    expect(readFileSync(join(home, aside!, "roster.json"), "utf8")).toBe("{}")
    expect(said.at(-1)).toContain(join(home, aside!))
  })

  test("a second --purge finds no data folder, says so and moves nothing", async () => {
    const { base, home, said } = install()
    expect(await uninstall({ ...base, confirm: async () => true, purge: true })).toBe(0)
    expect(await uninstall({ ...base, confirm: async () => true, purge: true })).toBe(0)
    expect(said.at(-1)).toContain("there was no")
    expect(readdirSync(home).filter((name) => name.startsWith(".playground-purged-"))).toHaveLength(
      1,
    )
  })

  test("removes the home skill set and its marketplace from Claude Code, naming both, and a second run calls neither", async () => {
    const { base, calls, said } = install()
    const removals = () =>
      calls.filter(
        (argv) => argv[0] === "claude" && (argv[2] === "uninstall" || argv[3] === "remove"),
      )
    expect(await uninstall({ ...base, confirm: async () => true, purge: false })).toBe(0)
    expect(removals()).toEqual([
      ["claude", "plugin", "uninstall", "ws-home@ws", "--scope", "user"],
      ["claude", "plugin", "marketplace", "remove", "ws"],
    ])
    expect(said).toContain("removed the home skill set ws-home@ws from Claude Code")
    expect(said).toContain("removed the marketplace ws from Claude Code")
    calls.length = 0
    expect(await uninstall({ ...base, confirm: async () => true, purge: false })).toBe(0)
    expect(removals()).toEqual([])
  })

  test("a stack whose dev:stop fails is named as not stopped with its error, the rest still goes, and it exits 1", async () => {
    const { base, calls, home, said } = install()
    const run: Run = async (argv) => {
      calls.push(argv)
      return argv.at(-1) === "dev:stop"
        ? {
            code: 1,
            out: "$ bun dev-stop.ts\nerror: Cannot find module '@packages/env/data-dir'\n",
          }
        : { code: 0, out: "" }
    }
    expect(await uninstall({ ...base, confirm: async () => true, purge: false, run })).toBe(1)
    expect(said).toContain(
      `did not stop the stack in ${base.stacks[0]}: error: Cannot find module '@packages/env/data-dir'`,
    )
    expect(said.some((line) => line.startsWith("stopped the stack"))).toBe(false)
    expect(linked(join(home, ".claude", "skills", "pr"))).toBe(false)
  })

  test("with no claude on PATH it leaves Claude Code alone", async () => {
    const { base, calls } = install()
    expect(
      await uninstall({ ...base, claude: false, confirm: async () => true, purge: false }),
    ).toBe(0)
    expect(calls.some((argv) => argv[0] === "claude")).toBe(false)
  })

  // #2203: Linux has no LaunchAgents; each job is a systemd user unit in ~/.config/systemd/user
  test("on Linux disables and removes the systemd user units that run from the checkout or the data folder, and no other", async () => {
    const { base, calls, home, repo, said } = install()
    const units = join(home, ".config", "systemd", "user")
    write(
      join(units, "com.playground.ops-tick.service"),
      `[Service]\nExecStart="/b/bun" "${repo}/packages/scripts/src/ops-tick/cli.ts"\n`,
    )
    write(join(units, "syncthing.service"), '[Service]\nExecStart="/usr/bin/syncthing"\n')
    expect(
      await uninstall({ ...base, confirm: async () => true, platform: "linux", purge: false }),
    ).toBe(0)
    // #2314: each call finds the user's bus from a pane with no XDG_RUNTIME_DIR, as userSystemctl builds it
    expect(calls.filter((argv) => argv.includes("systemctl"))).toEqual([
      userSystemctl(["disable", "--now", "com.playground.ops-tick.service"]),
      userSystemctl(["daemon-reload"]),
    ])
    expect(existsSync(join(units, "com.playground.ops-tick.service"))).toBe(false)
    expect(existsSync(join(units, "syncthing.service"))).toBe(true)
    expect(calls.some((argv) => argv[0] === "launchctl")).toBe(false)
    expect(said).toContain(`removed ${join(units, "com.playground.ops-tick.service")}`)
  })

  test("a second run finds nothing left and still exits 0", async () => {
    const { base } = install()
    await uninstall({ ...base, confirm: async () => true, purge: false })
    expect(await uninstall({ ...base, confirm: async () => true, purge: false })).toBe(0)
  })
})
