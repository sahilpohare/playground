import { expect, test } from "bun:test"
import { join } from "node:path"

const read = () =>
  Bun.file(join(import.meta.dir, "../../../scripts/briefs/new-research-worker.md")).text()

// issue 2167: the planner's standing research-brief lines live in this template alone
test("the research worker template holds the planner's seven standing lines and the signal rule", async () => {
  const text = await read()
  for (const line of [
    "Load the playbook skill with the Skill tool, and report to the planner by `SendMessage`.",
    "Send the planner your ETA to your answer: `date -u +%FT%TZ` plus your estimate.",
    "Read only. Sign up for nothing, add nothing to a cart, and enter no pincode or address.",
    "Run no build, suite, install or other run-slot command, since a `--reads-only` start took no slot room.",
    "Keep the environment and every secret out of every output.",
    "One plain command per call, with absolute paths and no `cd`.",
    "In a plan for a guard, each literal form is data. It goes only into the mode-600 plan file and `SendMessage`, never reaches a shell, and stays out of every issue, commit, PR and comment.",
    "**signal**: signal only processes you started, by their own handle",
  ])
    expect(text).toContain(line)
})

test("the research worker template's last step reports, then the planner closes the session", async () => {
  const steps = (await read()).split("\n").filter((l) => /^\d+\. /.test(l))
  const last = steps.at(-1) ?? ""
  expect(last).toMatch(
    /^5\. Clear `~\/\.playground\/scratch\/<your name>\/` with `playground rm <path>`/,
  )
  expect(last).toContain("then report the answer or the plan to the planner by `SendMessage`")
  expect(last).toContain("so the planner closes your pane with `spawn.sh close <your name>`")
  const planner = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/planner.md")).text()
  expect(planner).toContain(
    'close each with `"${PLAYGROUND_REPO:?}/scripts/spawn.sh" close <id>-worker`',
  )
})

// issue 2311: without --reports-to, spawn.sh tells a research worker it reports to the builder
test("the planner starts each research worker reporting to itself", async () => {
  const planner = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/planner.md")).text()
  expect(planner).toContain(
    '`"${PLAYGROUND_REPO:?}/scripts/spawn.sh" worker <id>-worker <brief> --title "<title>" --account <email> --reports-to <your session name>`',
  )
})

test("the download, PDF and site-write lines live in the template, not in planner.md", async () => {
  const template = await read()
  const planner = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/planner.md")).text()
  for (const line of [
    "counts as a write",
    "Save every download inside one of your own folders",
    "Read tool's `pages` parameter",
  ]) {
    expect(template).toContain(line)
    expect(planner).not.toContain(line)
  }
  expect(planner).toContain("`~/.playground/handoffs/new-research-worker.md`")
})

// issue 2729: a release cited as a project's latest is a stable one, not a pre-release
test("the research worker template says a release cited as latest is stable", async () => {
  const template = await read()
  expect(template).toContain(
    "A release cited as a project's latest has `prerelease: false` and `draft: false` on GitHub's releases API (`gh api repos/<owner>/<repo>/releases`), and a pre-release is named as one.",
  )
})

// issue 2729: a release cited as a project's latest is a stable one, not a pre-release
test("the planner's own writes cite a stable release as latest (#2729)", async () => {
  const planner = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/planner.md")).text()
  expect(planner).toContain(
    "A release you cite as a project's latest in a deck or card you edit yourself has `prerelease: false` and `draft: false` on GitHub's releases API (`gh api repos/<owner>/<repo>/releases`), and a pre-release is named as one.",
  )
})
