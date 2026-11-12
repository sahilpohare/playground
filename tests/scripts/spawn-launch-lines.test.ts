import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { HARNESSES, pinText } from "../../packages/settings/src/harnesses"
import { OLD } from "../session-names"
import { launchOf, lw, root, scratch, spawn, typed, type Spawned } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// The main checkout spawn.sh exports as PLAYGROUND_REPO, which a worktree's run names beside the worktree and a clone's run names as the clone.
const main = dirname(
  Bun.spawnSync(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    .stdout.toString()
    .trim(),
)

// What a start or a resume runs, with the paths of the case's own home and scratch folder, the checkout, the skill plugin named by the skills it holds and the session's new id written as names, so a run anywhere reads the same.
const launch = (r: Spawned, name: string) => {
  const resume = lw(r.home, "resume", `${name}.sh`)
  const text = [
    `typed: ${typed(r)}`,
    `launch:\n${launchOf(r)}`,
    `resume:\n${existsSync(resume) ? readFileSync(resume, "utf8") : "(none)\n"}`,
  ].join("\n")
  return text
    .replaceAll(r.home, "{home}")
    .replaceAll(scratch, "{scratch}")
    .replaceAll(root, "{checkout}")
    .replaceAll(main, "{checkout}")
    .replace(/ --plugin-dir \S+/g, " --plugin-dir {plugin}")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}")
}

type Case = { args: string[]; name: string; pin?: string }
const CASES: Record<string, Case> = {
  "a worker on Claude": {
    args: ["worker", "worker-brave-otter", "b.md"],
    name: "worker-brave-otter",
  },
  "a worker on GLM": {
    args: ["worker", "worker-brave-otter", "b.md", "--backend", "glm"],
    name: "worker-brave-otter",
  },
  "a reviewer column": {
    args: ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
    name: "reviewer-x",
  },
  "a manager on Claude": { args: ["manager", OLD.builder, "b.md"], name: OLD.builder },
  "a manager on GLM": {
    args: ["manager", `${OLD.dispatcher}-2`, "b.md", "--backend", "glm"],
    name: `${OLD.dispatcher}-2`,
  },
  "a resume pinned on Claude": {
    args: ["resume", "worker-brave-otter", root],
    name: "worker-brave-otter",
    pin: "claude",
  },
  "a resume pinned on GLM": {
    args: ["resume", "worker-brave-otter", root],
    name: "worker-brave-otter",
    pin: "glm",
  },
  "a resume with --backend claude and no pin": {
    args: ["resume", "worker-brave-otter", root, "--backend", "claude"],
    name: "worker-brave-otter",
  },
}

// The lines spawn.sh ran at canary 5d1faecd7, before the harness split; a change to one is a change to how a session runs, made on purpose in fixtures/launch-lines.json.
const EXPECTED: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "launch-lines.json"), "utf8"),
)

describe("spawn.sh's launch lines stay byte for byte the same", () => {
  test.each(Object.keys(CASES))("%s", async (label) => {
    const c = CASES[label]!
    const r = await spawn(
      c.args,
      [],
      {},
      undefined,
      c.pin ? { name: c.name, backend: c.pin } : undefined,
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launch(r, c.name)).toBe(EXPECTED[label]!)
  })
})

// A pin in the new shape, Claude Code then each of its backends, resumes as the old pin of its backend does.
describe("a resume from a pin naming its harness runs the old pin's launch line", () => {
  test.each(
    HARNESSES.filter((h) => h.id === "claude-code").flatMap((h) =>
      h.backends.map((backend) => [h.id, backend] as const),
    ),
  )("%s %s", async (harness, backend) => {
    const label = `a resume pinned on ${backend === "glm" ? "GLM" : "Claude"}`
    const c = CASES[label]!
    const r = await spawn(c.args, [], {}, undefined, {
      name: c.name,
      backend: pinText(harness, backend),
    })
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launch(r, c.name)).toBe(EXPECTED[label]!)
  })
})
