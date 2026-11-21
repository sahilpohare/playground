import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { log, repo, turbo } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang
setDefaultTimeout(60_000)

// 5 Nov: a bash script named after an option word, and its cached-build rule, read as bash reads the file
describe("a bash script file: the option word and the cached build", () => {
  const COMMITS = [
    "#!/bin/bash",
    "# commit and push the docs",
    "set -euo pipefail",
    "cd ROOT",
    "git add docs/notes.md",
    "git commit -m x",
    "git push origin",
  ]
  const script = (m: ReturnType<typeof repo>, lines: string[]) => {
    const path = join(m.root, "outside", "chain.sh")
    mkdirSync(join(m.root, "outside"), { recursive: true })
    writeFileSync(path, lines.join("\n").replaceAll("ROOT", m.root) + "\n")
    return path
  }

  // bash runs the file after an option's argument, so a listed script named as --rcfile's argument must not stand in for it
  test("named after an option word waits and never takes run-slot-commit", async () => {
    const m = repo({ idle: 30 }, [], ["docs/notes.md"])
    m.hold("run-slot", 3, "big")
    const safe = script(m, COMMITS)
    expect(await m.start("worker-x", {}, undefined, ["bash", "--rcfile", safe, safe]).waits()).toBe(
      true,
    )
    expect(log(m)).not.toContain("run-slot-commit")
  })

  // a script's commit of a web/next file follows the cached-build rule, as a lone commit does
  const NEXT = [...COMMITS.slice(0, 4), "git add web/next/src/app/page.tsx", ...COMMITS.slice(5)]
  test("that commits a web/next file turbo replays from its cache takes run-slot-commit beside a big run", async () => {
    const m = repo({ idle: 30 }, [], ["web/next/src/app/page.tsx"])
    turbo(m, "HIT")
    m.hold("run-slot", 3, "big")
    await m.start("worker-x", {}, undefined, ["bash", script(m, NEXT)]).p.exited
    expect(log(m)).toMatch(/ start worker-x \d+ run-slot-commit waited=/)
  })

  test("that commits a web/next file with one task to build takes run-slot-commit beside a big run", async () => {
    const m = repo({ idle: 30 }, [], ["web/next/src/app/page.tsx"])
    turbo(m, "MISS")
    m.hold("run-slot", 3, "big")
    await m.start("worker-x", {}, undefined, ["bash", script(m, NEXT)]).p.exited
    expect(log(m)).toMatch(/ start worker-x \d+ run-slot-commit waited=/)
  })

  test("that commits a web/next file whose dry run fails waits as a big run", async () => {
    const m = repo({ idle: 30 }, [], ["web/next/src/app/page.tsx"])
    turbo(m, null)
    m.hold("run-slot", 3, "big")
    expect(await m.start("worker-x", {}, undefined, ["bash", script(m, NEXT)]).waits()).toBe(true)
    expect(log(m)).not.toContain("run-slot-commit")
  })
})
