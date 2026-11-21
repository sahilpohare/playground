import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { machine, SCRIPT, spawn } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang
setDefaultTimeout(60_000)

// #1321: chain_steps read a line's trailing comment with the code, so a quote in one line's comment paired into the words after it and the commit step read as no program: the chain left the commit lane
describe("a comment's quotes leave the commit lane's read alone", () => {
  // kind runs nothing, so the lane decision reads the named repo's forms alone, as run-slot.sh kind does; the chain names a throwaway repo, since the lane reads the named repo's index and lefthook.yml
  const kind = async (scriptOf: (repo: string) => string) => {
    const m = machine()
    const repo = join(m.root, "repo")
    mkdirSync(repo)
    expect(Bun.spawnSync(["git", "-C", repo, "init"]).exitCode).toBe(0)
    const p = spawn(["bash", SCRIPT, "kind", "--", "bash", "-c", scriptOf(repo)], {
      cwd: m.root,
      env: m.env(),
      stdout: "pipe",
    })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text()).trim()
  }

  test("a chain whose commit message names an issue keeps the lane past a comment holding a quote", async () => {
    expect(
      await kind(
        (repo) =>
          `git -C ${repo} add -A && git -C ${repo} commit -m "fix: the gate (#1321)" # take "two`,
      ),
    ).toBe("commit")
  })

  test("while a quoted hash in the message stays the message's own text with no comment in the chain", async () => {
    expect(
      await kind(
        (repo) => `git -C ${repo} add -A && git -C ${repo} commit -m "fix: the gate (#1321)"`,
      ),
    ).toBe("commit")
  })
})
