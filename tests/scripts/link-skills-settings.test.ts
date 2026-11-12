import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { OLD } from "../session-names"

const root = join(import.meta.dir, "..", "..")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "link-skills-917-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// A claude on PATH that logs its words, so the home skill set's install never reaches the real Claude Code.
const fakeBin = join(scratch, "bin")
mkdirSync(fakeBin)
writeFileSync(join(fakeBin, "claude"), '#!/bin/bash\necho "$*" >> "$HOME/claude.calls"\n')
chmodSync(join(fakeBin, "claude"), 0o755)

// git's own variables are dropped and its system and XDG configs kept out, so a run inside a git hook never reaches the real checkout.
const isolatedEnv = (home: string) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  CLAUDE_CONFIG_DIR: "",
  HOME: home,
  PATH: `${fakeBin}:${process.env.PATH}`,
  PLAYGROUND_DATA_DIR: "",
  XDG_CONFIG_HOME: "",
})

const git = (repo: string, home: string, ...args: string[]) => {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: isolatedEnv(home),
  })
  return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}` }
}

let made = 0
// A scratch checkout holding what the script reads (its own scripts/), and a scratch HOME.
const setup = () => {
  const repo = join(scratch, `repo-${++made}`)
  mkdirSync(join(repo, "scripts"), { recursive: true })
  for (const file of ["link-skills.sh", "factory-settings.json"])
    cpSync(join(root, "scripts", file), join(repo, "scripts", file))
  chmodSync(join(repo, "scripts", "link-skills.sh"), 0o755)
  // The resolver the home set runs, from the real checkout's packages and modules.
  for (const dir of ["node_modules", "packages"]) symlinkSync(join(root, dir), join(repo, dir))
  const home = join(scratch, `home-${made}`)
  mkdirSync(join(home, ".playground"), { recursive: true })
  git(repo, home, "init", "-q", "-b", "main")
  return { home, repo, settings: join(home, ".playground", "factory-settings.json") }
}

const run = async (repo: string, home: string) => {
  const proc = Bun.spawn(["bash", join(repo, "scripts", "link-skills.sh")], {
    cwd: repo,
    env: isolatedEnv(home),
    stderr: "pipe",
    stdout: "pipe",
  })
  return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
}

// The factory's settings name no checkout, so the installed file is a link to the checkout's own, which a pull keeps current.
describe("link-skills.sh links the factory's settings", () => {
  test("a first run links the file to the checkout's scripts/factory-settings.json", async () => {
    const { home, repo, settings } = setup()
    expect((await run(repo, home)).code).toBe(0)
    expect(lstatSync(settings).isSymbolicLink()).toBe(true)
    expect(readlinkSync(settings)).toBe(join(repo, "scripts", "factory-settings.json"))
  })

  test("a link from before is pointed at this checkout", async () => {
    const { home, repo, settings } = setup()
    writeFileSync(join(home, "elsewhere.json"), "{}")
    symlinkSync(join(home, "elsewhere.json"), settings)
    expect((await run(repo, home)).code).toBe(0)
    expect(readlinkSync(settings)).toBe(join(repo, "scripts", "factory-settings.json"))
  })

  test("a hand-made real file moves to .mine and the link takes its place", async () => {
    const { home, repo, settings } = setup()
    writeFileSync(settings, "{}")
    const result = await run(repo, home)
    expect(result.code).toBe(0)
    expect(readFileSync(`${settings}.mine`, "utf8")).toBe("{}")
    expect(lstatSync(settings).isSymbolicLink()).toBe(true)
  })

  test("with .mine taken too, it stops and names both", async () => {
    const { home, repo, settings } = setup()
    writeFileSync(settings, "{}")
    writeFileSync(`${settings}.mine`, "old")
    const result = await run(repo, home)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `skipped ${settings}: a real file, and ${settings}.mine is taken`,
    )
    expect(readFileSync(settings, "utf8")).toBe("{}")
  })
})

// The brief templates and the `playground` command, each a link into the checkout, so a pull keeps them current.
describe("link-skills.sh links the playground command and its brief templates", () => {
  test("a first run links ~/.bun/bin/playground, the only command it links, and every brief in handoffs/ into the checkout", async () => {
    const { home, repo } = setup()
    expect((await run(repo, home)).code).toBe(0)
    expect(readdirSync(join(home, ".bun", "bin"))).toEqual(["playground"])
    expect(readlinkSync(join(home, ".bun", "bin", "playground"))).toBe(
      join(repo, "packages", "scripts", "src", "playground", "cli.ts"),
    )
    for (const brief of ["new-reviewer.md", "new-tester.md", "new-worker.md"])
      expect(readlinkSync(join(home, ".playground", "handoffs", brief))).toBe(
        join(repo, "scripts", "briefs", brief),
      )
  })

  test("a first run links brief-rush.md beside the state files into the checkout (#2235)", async () => {
    const { home, repo } = setup()
    expect((await run(repo, home)).code).toBe(0)
    expect(readlinkSync(join(home, ".playground", "brief-rush.md"))).toBe(
      join(repo, "scripts", "briefs", "brief-rush.md"),
    )
  })

  test("a real brief-rush.md beside the state files is moved aside, then linked (#2235)", async () => {
    const { home, repo } = setup()
    const folder = join(home, ".playground")
    writeFileSync(join(folder, "brief-rush.md"), "old copy")
    expect((await run(repo, home)).code).toBe(0)
    expect(readlinkSync(join(folder, "brief-rush.md"))).toBe(
      join(repo, "scripts", "briefs", "brief-rush.md"),
    )
    const kept = readdirSync(folder).filter((name) => name.startsWith("brief-rush.md.replaced-"))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(folder, kept[0]!), "utf8")).toBe("old copy")
  })

  test("a second run keeps the link and moves nothing else aside (#2235)", async () => {
    const { home, repo } = setup()
    const folder = join(home, ".playground")
    writeFileSync(join(folder, "brief-rush.md"), "old copy")
    expect((await run(repo, home)).code).toBe(0)
    expect((await run(repo, home)).code).toBe(0)
    expect(readlinkSync(join(folder, "brief-rush.md"))).toBe(
      join(repo, "scripts", "briefs", "brief-rush.md"),
    )
    const kept = readdirSync(folder).filter((name) => name.startsWith("brief-rush.md.replaced-"))
    expect(kept).toHaveLength(1)
  })

  test("a first run links each merge-train and usage script into ~/.playground/ops (#1733)", async () => {
    const { home, repo } = setup()
    expect((await run(repo, home)).code).toBe(0)
    for (const script of [
      "beat.py",
      "merge-train/run.py",
      "usage/account-watch.py",
      "usage/glm-credits.py",
      "usage/login-flip.py",
      "usage/near-limit.py",
      "usage/run.py",
      "usage/week-marks.py",
    ])
      expect(readlinkSync(join(home, ".playground", "ops", script))).toBe(
        join(repo, "scripts", "ops", script),
      )
  })

  // merge-train/run.py queues its lines through ops/notify.sh, and a linked script's call of a sibling by name finds it in the state folder only if a link put it there.
  test("every ops script a linked script joins onto OPS by name is linked too (PG-2457)", async () => {
    const { home, repo } = setup()
    expect((await run(repo, home)).code).toBe(0)
    const ops = join(home, ".playground", "ops")
    const linked = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? linked(join(dir, entry.name))
          : lstatSync(join(dir, entry.name)).isSymbolicLink()
            ? [relative(ops, join(dir, entry.name))]
            : [],
      )
    const installed = new Set(linked(ops))
    const called = new Set<string>()
    for (const script of installed)
      for (const match of readFileSync(join(root, "scripts", "ops", script), "utf8").matchAll(
        /os\.path\.join\(OPS, "([\w.-]+\.(?:sh|py))"\)/g,
      ))
        called.add(match[1]!)
    expect([...called]).toContain("notify.sh")
    expect([...called].filter((name) => !installed.has(name))).toEqual([])
  })

  test("a real beat.py in the state folder is moved aside, then linked", async () => {
    const { home, repo } = setup()
    const ops = join(home, ".playground", "ops")
    mkdirSync(ops, { recursive: true })
    writeFileSync(join(ops, "beat.py"), "old copy")
    expect((await run(repo, home)).code).toBe(0)
    expect(readlinkSync(join(ops, "beat.py"))).toBe(join(repo, "scripts", "ops", "beat.py"))
    const kept = readdirSync(ops).filter((name) => name.startsWith("beat.py.replaced-"))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(ops, kept[0]!), "utf8")).toBe("old copy")
  })

  test("a real file at ~/.bun/bin/playground moves to .mine and the link takes its place", async () => {
    const { home, repo } = setup()
    const bin = join(home, ".bun", "bin", "playground")
    mkdirSync(join(home, ".bun", "bin"), { recursive: true })
    writeFileSync(bin, "mine")
    const result = await run(repo, home)
    expect(result.code).toBe(0)
    expect(readFileSync(`${bin}.mine`, "utf8")).toBe("mine")
    expect(lstatSync(bin).isSymbolicLink()).toBe(true)
  })
})

// Why rerere goes off: scripts/README.md, link-skills.sh and rerere.
describe("link-skills.sh turns rerere off for the checkout", () => {
  test("a merge that replayed a recorded resolution before the run replays none after it", async () => {
    const { home, repo } = setup()
    mkdirSync(join(repo, ".git", "rr-cache"))
    const file = join(repo, "a.txt")
    writeFileSync(file, "base\n")
    git(repo, home, "add", "a.txt")
    git(repo, home, "commit", "-qm", "base")
    git(repo, home, "checkout", "-qb", "side")
    writeFileSync(file, "side\n")
    git(repo, home, "commit", "-qam", "side")
    git(repo, home, "checkout", "-q", "main")
    writeFileSync(file, "main\n")
    git(repo, home, "commit", "-qam", "main")
    expect(git(repo, home, "merge", "side").code).not.toBe(0)
    writeFileSync(file, "both\n")
    git(repo, home, "add", "a.txt")
    expect(git(repo, home, "commit", "-q", "--no-edit").out).toContain(
      "Recorded resolution for 'a.txt'",
    )
    git(repo, home, "reset", "-q", "--hard", "HEAD~1")
    expect(git(repo, home, "merge", "side").out).toContain("using previous resolution")
    git(repo, home, "reset", "-q", "--hard")

    expect((await run(repo, home)).code).toBe(0)
    expect(git(repo, home, "config", "rerere.enabled").out.trim()).toBe("false")
    const merge = git(repo, home, "merge", "side")
    expect(merge.code).not.toBe(0)
    expect(merge.out).not.toContain("using previous resolution")
    expect(readFileSync(file, "utf8")).toContain("<<<<<<<")
  })
})

// Playground's skills reach a session as a plugin, and a personal skill takes a bare name over any plugin's, so no link stays in ~/.claude/skills at a name the home set ships: inscope's link at pr would otherwise run upstream's copy, while its other links stay. The resolver reads the real checkout's core, so the names are core's own.
describe("link-skills.sh leaves no personal skill at a name playground's set ships", () => {
  // the set is written from the checkout orgs.ts runs from, the real one here, so a link into it is Playground's own
  test("a link into Playground's checkout at a name the set ships goes, and another tool's links stay, at a shipped name too", async () => {
    const { home, repo } = setup()
    const skills = join(home, ".claude", "skills")
    const cache = join(home, "inscope-cache")
    for (const name of ["archify", "pr"]) mkdirSync(join(cache, name), { recursive: true })
    mkdirSync(skills, { recursive: true })
    for (const name of ["archify", "pr"]) symlinkSync(join(cache, name), join(skills, name))
    symlinkSync(join(root, "extensions", "core", "skills", "tdd"), join(skills, "tdd"))
    symlinkSync(join(repo, "skills", "playground", "gone"), join(skills, "gone"))
    expect((await run(repo, home)).code).toBe(0)
    expect(readdirSync(skills).sort()).toEqual(["archify", "pr"])
    expect(readlinkSync(join(skills, "pr"))).toBe(join(cache, "pr"))
  })

  test("a real folder at a name the set ships moves to my-skills and links back", async () => {
    const { home, repo } = setup()
    const mine = join(home, ".claude", "skills", "pr")
    mkdirSync(mine, { recursive: true })
    const result = await run(repo, home)
    expect(result.code).toBe(0)
    const kept = join(home, ".claude", "my-skills", "pr")
    expect(readlinkSync(mine)).toBe(kept)
    expect(lstatSync(kept).isDirectory()).toBe(true)
  })

  test("the home skill set is written and installed at user scope through the ws marketplace", async () => {
    const { home, repo } = setup()
    expect((await run(repo, home)).code).toBe(0)
    const orgs = join(home, ".playground", "orgs")
    expect(readFileSync(join(home, "claude.calls"), "utf8").split("\n").filter(Boolean)).toEqual([
      "plugin list",
      `plugin marketplace add ${orgs}`,
      "plugin install ws-home@ws --scope user",
    ])
    const { plugins } = JSON.parse(
      readFileSync(join(orgs, ".claude-plugin", "marketplace.json"), "utf8"),
    )
    expect(readdirSync(join(orgs, plugins[0].source, "skills"))).toContain("playbook")
  })
})

// The rename: a home holding the old data folder keeps the new one as it is, and playground-factory's old name goes.
const RENAMED = {
  data: [".playground", join(".claude", OLD.dispatcher)],
  factory: ["playground-factory", `${OLD.dispatcher}-factory`],
}
describe("link-skills.sh and the names from before the rename", () => {
  const [data, oldData] = RENAMED.data
  test("a home that already has the new data folder keeps it as it is", async () => {
    const { home, repo } = setup()
    mkdirSync(join(home, oldData!), { recursive: true })
    expect((await run(repo, home)).code).toBe(0)
    expect(lstatSync(join(home, data!)).isDirectory()).toBe(true)
  })

  test("the factory skill's links under either name go", async () => {
    const { home, repo } = setup()
    mkdirSync(join(home, ".claude", "skills"), { recursive: true })
    for (const name of RENAMED.factory)
      symlinkSync(join(repo, "skills", "playground", name), join(home, ".claude", "skills", name))
    expect((await run(repo, home)).code).toBe(0)
    expect(readdirSync(join(home, ".claude", "skills"))).toEqual([])
  })
})

// A pull that removes a linked file leaves its link dangling, which doctor names MISSING: the next run clears it.
describe("link-skills.sh prunes the links a pull left dangling", () => {
  test("a dead link into the checkout goes, while a live one and a dead one elsewhere stay", async () => {
    const { home, repo } = setup()
    const ops = join(home, ".playground", "ops")
    mkdirSync(join(ops, "checks"), { recursive: true })
    mkdirSync(join(home, ".bun", "bin"), { recursive: true })
    const dead = join(ops, "checks", "checks.py")
    const deadTop = join(home, ".playground", "gone.md")
    const deadBin = join(home, ".bun", "bin", "gone")
    const live = join(ops, "checks", "live.json")
    const elsewhere = join(ops, "checks", "elsewhere.py")
    symlinkSync(join(repo, "scripts", "ops", "checks", "checks.py"), dead)
    symlinkSync(join(repo, "gone.md"), deadTop)
    symlinkSync(join(repo, "scripts", "gone"), deadBin)
    symlinkSync(join(repo, "scripts", "factory-settings.json"), live)
    symlinkSync(join(scratch, "nowhere", "elsewhere.py"), elsewhere)
    const { code } = await run(repo, home)
    expect(code).toBe(0)
    const isLink = (path: string) => {
      try {
        return lstatSync(path).isSymbolicLink()
      } catch {
        return false
      }
    }
    expect([dead, deadTop, deadBin].filter(isLink)).toEqual([])
    expect(readlinkSync(live)).toBe(join(repo, "scripts", "factory-settings.json"))
    expect(readlinkSync(elsewhere)).toBe(join(scratch, "nowhere", "elsewhere.py"))
  })

  test("a data folder reached through a link is pruned too, as doctor reads it, and a linked folder in ops/ is not", async () => {
    const { home, repo } = setup()
    const real = join(scratch, `data-${made}`)
    rmSync(join(home, ".playground"), { force: true, recursive: true })
    mkdirSync(join(real, "handoffs"), { recursive: true })
    mkdirSync(join(scratch, `elsewhere-${made}`))
    mkdirSync(join(real, "ops"))
    symlinkSync(real, join(home, ".playground"))
    symlinkSync(join(scratch, `elsewhere-${made}`), join(real, "ops", "linked"))
    const deadTop = join(real, "gone.md")
    const deadHandoff = join(real, "handoffs", "gone.md")
    const inLinked = join(scratch, `elsewhere-${made}`, "gone.py")
    symlinkSync(join(repo, "gone.md"), deadTop)
    symlinkSync(join(repo, "scripts", "briefs", "gone.md"), deadHandoff)
    symlinkSync(join(repo, "scripts", "ops", "gone.py"), inLinked)
    expect((await run(repo, home)).code).toBe(0)
    const isLink = (path: string) => {
      try {
        return lstatSync(path).isSymbolicLink()
      } catch {
        return false
      }
    }
    expect([deadTop, deadHandoff].filter(isLink)).toEqual([])
    expect(readlinkSync(inLinked)).toBe(join(repo, "scripts", "ops", "gone.py"))
  })
})
