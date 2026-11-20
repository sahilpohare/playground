import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { dirname, join } from "node:path"

import { OLD } from "../session-names"
import { placing, root, spawn, TRUSTED } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

const yes = (folder: string, accepted: unknown = true) =>
  JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: accepted } } })

// #2307: a fresh machine's first dispatcher waited on Claude Code's folder trust question with No, exit marked, so a session in this checkout starts only once the owner has said yes.
describe("a session in this checkout starts only once Claude Code trusts it (#2307)", () => {
  const STEP = "click Trust this folder on Claude Code's card"

  test("a worker on a machine with no yes is refused before any pane opens, naming the step", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { NO_CLAUDE_TRUST: "1" })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(
      `spawn.sh refuses worker-brave-otter: Claude Code would stop on its folder trust question in ${root}`,
    )
    expect(r.err).toContain(STEP)
  })

  test("the first dispatcher on a machine with no yes is refused in its leads worktree, naming the step", async () => {
    const r = await spawn(["manager", OLD.dispatcher, `brief-${OLD.dispatcher}.md`], [], {
      NO_CLAUDE_TRUST: "1",
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      `folder trust question in ${join(r.home, "code", "factory", ".claude", "worktrees", "leads")}`,
    )
    expect(r.err).toContain(STEP)
  })

  test("a yes on the main checkout covers a worker in a worktree under it, as Claude Code reads it", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      CLAUDE_JSON: yes(TRUSTED[0]!),
      NO_CLAUDE_TRUST: "1",
    })
    expect(r.code).toBe(0)
  })

  test("a no, a yes for another folder, or a yes on the folder above the checkout alone is refused", async () => {
    for (const config of [
      yes(TRUSTED[0]!, false),
      yes(join(TRUSTED[0]!, "elsewhere")),
      yes(dirname(TRUSTED[0]!)),
    ]) {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        CLAUDE_JSON: config,
        NO_CLAUDE_TRUST: "1",
      })
      expect(r.code).toBe(1)
      expect(r.err).toContain(STEP)
    }
  })
})
