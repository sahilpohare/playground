import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Io, runStore } from "../../../../../packages/scripts/src/playground/store"
import { writeFiles } from "../../../../../packages/settings/src/folder"
import { extensionsDir, scopeDir } from "../../../../../packages/settings/src/rendered"

process.env.PLAYGROUND_LOGIN = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "playground-settings-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
let n = 0

// Each run against its own data folder.
const cli = (checkout?: string) => {
  const data = join(scratch, `data-${n++}`)
  const run = async (words: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const io: Io = {
      checkout,
      data,
      out: (l) => out.push(l),
      stdin: async () => "",
      write: Bun.write,
    }
    const code = await runStore("settings", words, io, (l) => err.push(l))
    return { code, err: err.join("\n"), out: out.join("\n") }
  }
  return { data, run }
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"))

describe("playground settings", () => {
  test("set writes the login's settings.json as a value parsed as JSON, and get and why read it back", async () => {
    const { data, run } = cli()
    const set = await run(["set", "factory.repo", "made-up-me/copy", "--reason", "my copy"])
    expect(set).toMatchObject({ code: 0, err: "" })
    expect(JSON.parse(set.out)).toEqual({
      key: "factory.repo",
      scope: "made-up-me",
      value: "made-up-me/copy",
    })
    expect(json(join(scopeDir(data, "made-up-me"), "settings.json"))).toEqual({
      "factory.repo": "made-up-me/copy",
    })
    expect(json(join(extensionsDir(data), "policy.json")).values).toMatchObject({
      "factory.repo": "made-up-me/copy",
    })
    expect(JSON.parse((await run(["get", "factory.repo"])).out).value).toBe("made-up-me/copy")
    const why = JSON.parse((await run(["why", "factory.repo"])).out)
    expect(why).toHaveLength(1)
    expect(why[0]).toMatchObject({
      author: "owner",
      newValue: "made-up-me/copy",
      oldValue: null,
      reason: "my copy",
      scope: "made-up-me",
    })
  })

  test("--scope names an extension, --by names who asked, and get --org reads as a repo of that org", async () => {
    const { run } = cli()
    await run(["set", "ext.links", '{"acme":["acme"]}', "--reason", "acme's repos read acme"])
    await run(["set", "ext.order", '["acme"]', "--reason", "acme first"])
    await run([
      "set",
      "factory.repo",
      "acme/copy",
      "--reason",
      "r",
      "--scope",
      "acme",
      "--by",
      "builder",
    ])
    expect(JSON.parse((await run(["get", "factory.repo", "--org", "acme"])).out).value).toBe(
      "acme/copy",
    )
    expect(JSON.parse((await run(["why", "factory.repo"])).out)[0].author).toBe("builder")
  })

  test("a write with no reason or to core is a usage error, exit 2, and nothing is written", async () => {
    const { data, run } = cli()
    const r = await run(["reset", "factory.repo"])
    expect(r.code).toBe(2)
    expect(r.err).toStartWith(
      "playground settings: --reason is required\nusage: playground settings",
    )
    const core = await run(["set", "factory.repo", "x", "--reason", "r", "--scope", "core"])
    expect(core.code).toBe(2)
    expect(core.err).toStartWith("playground settings: core is read-only")
    expect(JSON.parse((await run(["list"])).out).rows).toEqual([])
    expect(Bun.file(join(extensionsDir(data), "policy.json")).size).toBe(0)
  })

  test("a refused value or an unknown key exits 1 with its status", async () => {
    const { run } = cli()
    expect(await run(["why", "ui.nope"])).toEqual({
      code: 1,
      err: "playground settings: 404 no setting ui.nope",
      out: "",
    })
    const bad = await run(["set", "factory.repo", "not a repo", "--reason", "r"])
    expect(bad.code).toBe(1)
    expect(bad.err).toStartWith("playground settings: 400 factory.repo:")
    expect((await run(["reset", "factory.repo", "--reason", "r"])).err).toBe(
      "playground settings: 409 factory.repo has no value at made-up-me: it is at its default",
    )
  })

  test("reset of a retired job's stored row exits 0 and takes the row out (#2339)", async () => {
    const { data, run } = cli()
    await run(["set", "factory.repo", "made-up-me/copy", "--reason", "make the login"])
    const file = join(scopeDir(data, "made-up-me"), "settings.json")
    const stored = { ...json(file), "jobs.opsAwake": { enabled: true } }
    writeFiles(data, "made-up-me", new Map([["settings.json", JSON.stringify(stored)]]), {
      author: "owner",
      reason: "a row kept from before the job retired",
    })
    expect(await run(["reset", "jobs.opsAwake", "--reason", "clear it"])).toMatchObject({
      code: 0,
      err: "",
    })
    expect(json(file)).toEqual({ "factory.repo": "made-up-me/copy" })
  })

  test("import-jobs sets each job the registry knows at the login's scope, keeps the rest in jobs.json, and a dry run writes nothing", async () => {
    const { data, run } = cli()
    const dir = join(scratch, `import-jobs-${n}`)
    mkdirSync(join(dir, "agents"), { recursive: true })
    const jobs = join(dir, "jobs.json")
    writeFileSync(
      jobs,
      JSON.stringify({
        jobs: [
          {
            command: "/x/ops/sweep.sh",
            disabled: true,
            heartbeat: "ops-sweep",
            name: "ops-sweep",
            schedule: { every: 300 },
          },
          {
            heartbeat: "ops-tick",
            launchd: "com.example.ops-tick",
            name: "ops-tick",
            schedule: { every: 60 },
          },
          { command: "/x/company.sh", name: "ops-company" },
        ],
      }),
    )
    writeFileSync(
      join(dir, "agents", "com.example.ops-tick.plist"),
      "<plist><dict><key>ProgramArguments</key><array><string>/b/bun</string><string>/r/tick.ts</string></array><key>WorkingDirectory</key><string>/r</string></dict></plist>",
    )
    const agents = join(dir, "agents")
    const dry = await run(["import-jobs", jobs, "--launch-agents", agents, "--dry-run"])
    expect(dry.code).toBe(0)
    expect(dry.out.split("\n")).toEqual([
      "would set jobs.opsSweep at made-up-me, off",
      "would set jobs.opsTick at made-up-me, on",
      "kept ops-company: the registry does not know it, so jobs.json keeps it",
    ])
    expect(JSON.parse((await run(["list"])).out).rows).toEqual([])
    expect((await run(["import-jobs", jobs, "--launch-agents", agents])).code).toBe(0)
    const values = json(join(scopeDir(data, "made-up-me"), "settings.json"))
    expect(values["jobs.opsSweep"]).toMatchObject({ command: "/x/ops/sweep.sh", enabled: false })
    expect(values["jobs.opsTick"]).toMatchObject({
      cwd: "/r",
      enabled: true,
      launchd: "com.example.ops-tick",
      program: ["/b/bun", "/r/tick.ts"],
    })
    const why = JSON.parse((await run(["why", "jobs.opsTick"])).out)
    expect(why[0].reason).toBe(`imported from ${jobs} at the switch`)
  })

  test("set owner.names warns on stderr for each one-word entry, naming the tracked files trace-count's ownerName counts it in, and still writes", async () => {
    const repo = join(scratch, `repo-${n}`)
    const files: Record<string, string> = {
      "mail.md": "mail quillon@mail.test\n",
      "notes.md": "Quillon wrote this line.\n",
      "other.md": "quillonish is another word\n",
      "path.md": "see quillon/vault\n",
      "scripts/hooks/bundled/x.js": "quillon\n",
      "src/snake.ts": "const by_quillon_x = 1\n",
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    Bun.spawnSync(["git", "-C", repo, "init", "-q"])
    Bun.spawnSync(["git", "-C", repo, "add", "."])
    writeFileSync(join(repo, "loose.md"), "quillon\n")
    const { run } = cli(repo)
    const set = await run(["set", "owner.names", '["quillon","pat-dev"]', "--reason", "r"])
    expect(set.code).toBe(0)
    expect(JSON.parse(set.out).value).toEqual(["quillon", "pat-dev"])
    expect(set.err.split("\n")).toEqual([
      "playground settings: owner.names holds quillon, one word, which trace-count's ownerName kind counts in 2 tracked files:",
      "  notes.md",
      "  src/snake.ts",
    ])
    expect(JSON.parse((await run(["get", "owner.names"])).out).value).toEqual([
      "quillon",
      "pat-dev",
    ])
  })

  test("set owner.names with no one-word entry prints no warning", async () => {
    const repo = join(scratch, `repo-${n}`)
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, "notes.md"), "pat-dev wrote this\n")
    Bun.spawnSync(["git", "-C", repo, "init", "-q"])
    Bun.spawnSync(["git", "-C", repo, "add", "."])
    const set = await cli(repo).run(["set", "owner.names", '["pat-dev"]', "--reason", "r"])
    expect(set).toMatchObject({ code: 0, err: "" })
  })
})
