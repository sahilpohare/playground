import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { scratchEnv } from "../scratch-env"

const root = join(import.meta.dir, "..", "..")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "link-skills-unlinked-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// A claude that logs its words, so the home set's install never reaches the real Claude Code, and a bun whose install links settings' safe-delete as the real install would and logs its words, while every other call runs the real bun.
const fakeBin = join(scratch, "bin")
mkdirSync(fakeBin)
writeFileSync(join(fakeBin, "claude"), '#!/bin/bash\necho "$*" >> "$HOME/claude.calls"\n')
writeFileSync(
  join(fakeBin, "bun"),
  `#!/bin/bash\nif [ "$1" = install ]; then\n  echo "$*" >> "$HOME/bun.installs"\n  repo="\${@: -1}"\n  mkdir -p "$repo/packages/settings/node_modules/@packages"\n  ln -sfn "$repo/packages/safe-delete" "$repo/packages/settings/node_modules/@packages/safe-delete"\n  exit 0\nfi\nexec '${process.execPath}' "$@"\n`,
)
for (const name of ["bun", "claude"]) chmodSync(join(fakeBin, name), 0o755)

const env = (home: string) =>
  scratchEnv(home, {
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: "",
    PATH: `${fakeBin}:${process.env.PATH}`,
    PLAYGROUND_DATA_DIR: "",
    XDG_CONFIG_HOME: "",
  })

let made = 0
// A scratch checkout whose packages are copies, each with its own node_modules linking where the real one's entries resolve and a workspace package to its copy here, so an import resolves inside the scratch checkout; `omit` leaves one package's link out, as a pull that declared it and has not installed yet leaves it.
const checkout = (omit?: string) => {
  const repo = join(scratch, `repo-${++made}`)
  mkdirSync(join(repo, "scripts"), { recursive: true })
  for (const file of ["link-skills.sh", "factory-settings.json"])
    cpSync(join(root, "scripts", file), join(repo, "scripts", file))
  cpSync(join(root, "package.json"), join(repo, "package.json"))
  for (const dir of ["extensions", "node_modules", "skills"])
    symlinkSync(join(root, dir), join(repo, dir))
  for (const pkg of readdirSync(join(root, "packages"))) {
    const from = join(root, "packages", pkg)
    const to = join(repo, "packages", pkg)
    if (!existsSync(join(from, "package.json"))) continue
    cpSync(from, to, {
      filter: (src) => !/\/(node_modules|dist|\.turbo)$/.test(src),
      recursive: true,
    })
    const modules = join(from, "node_modules")
    if (!existsSync(modules)) continue
    for (const entry of readdirSync(modules))
      for (const name of entry.startsWith("@")
        ? readdirSync(join(modules, entry)).map((inner) => `${entry}/${inner}`)
        : [entry]) {
        if (`${pkg} ${name}` === omit) continue
        let target: string
        try {
          target = name.startsWith("@packages/")
            ? join(repo, "packages", name.slice("@packages/".length))
            : realpathSync(join(modules, name))
        } catch {
          continue
        }
        mkdirSync(dirname(join(to, "node_modules", name)), { recursive: true })
        symlinkSync(target, join(to, "node_modules", name))
      }
  }
  const home = join(scratch, `home-${made}`)
  mkdirSync(join(home, ".playground"), { recursive: true })
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo, env: env(home) })
  return { home, repo }
}

const run = async (repo: string, home: string) => {
  const proc = Bun.spawn(["bash", join(repo, "scripts", "link-skills.sh")], {
    cwd: repo,
    env: env(home),
    stderr: "pipe",
    stdout: "pipe",
  })
  return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
}

const installs = (home: string) =>
  existsSync(join(home, "bun.installs"))
    ? readFileSync(join(home, "bun.installs"), "utf8").split("\n").filter(Boolean)
    : []

// playground update runs link-skills.sh before its install, so a pull that declares a new workspace dependency (settings' safe-delete, on the hop to v0.0.34) reaches orgs.ts home with the link missing.
describe("link-skills.sh on a checkout a pull has outgrown", () => {
  test("installs before the home set when settings' safe-delete is not linked, and exits 0", async () => {
    const { home, repo } = checkout("settings @packages/safe-delete")
    const result = await run(repo, home)
    expect(result.stderr).toContain("unlinked packages/settings: @packages/safe-delete")
    expect(result.code).toBe(0)
    expect(installs(home)).toEqual([`install --frozen-lockfile --ignore-scripts --cwd ${repo}`])
    expect(
      existsSync(join(home, ".playground", "orgs", ".claude-plugin", "marketplace.json")),
    ).toBe(true)
  })

  test("a check that fails another way installs nothing and fails the run", async () => {
    const { home, repo } = checkout()
    writeFileSync(join(repo, "package.json"), JSON.stringify({ workspaces: 1 }))
    expect((await run(repo, home)).code).toBe(1)
    expect(installs(home)).toEqual([])
  })

  test("a fully linked checkout installs nothing", async () => {
    const { home, repo } = checkout()
    expect((await run(repo, home)).code).toBe(0)
    expect(installs(home)).toEqual([])
  })
})
