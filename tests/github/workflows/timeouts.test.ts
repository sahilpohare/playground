import { expect, test } from "bun:test"
import { join } from "node:path"

const DIR = join(import.meta.dir, "../../../.github/workflows")

type Step = { env?: Record<string, unknown>; run?: string }
type Workflow = { jobs: Record<string, { steps: Step[]; "timeout-minutes"?: number }> }
const read = async (name: string) =>
  Bun.YAML.parse(await Bun.file(join(DIR, name)).text()) as Workflow

// GitHub runs a job with no timeout-minutes for up to 360 minutes, so a hung suite holds a PR's checks for hours; a green run of either takes 2 to 4 minutes
test("every job of the two pull request checks stops at 20 minutes", async () => {
  for (const name of ["auto-check-build.yml", "auto-test.yml"]) {
    const { jobs } = await read(name)
    for (const [id, job] of Object.entries(jobs))
      expect([name, id, job["timeout-minutes"]]).toEqual([name, id, 20])
  }
})

// zsh-cache's one step takes about 7.5 minutes at its longest: 2 apt tries capped at 150 s, a 15 s wait and a Homebrew install capped at 130 s
test("zsh-cache's job stops at 10 minutes", async () => {
  const { jobs } = await read("zsh-cache.yml")
  expect(Object.values(jobs).map((job) => job["timeout-minutes"])).toEqual([10])
})

test("each shard's suite deadline, which names the file it hangs in, is set 10 minutes inside the job's timeout", async () => {
  const { jobs } = await read("auto-check-build.yml")
  for (const job of Object.values(jobs)) {
    const suite = job.steps.find((step) => /test-sandbox\.ts/.test(step.run ?? ""))
    if (!suite) continue
    const deadline = Number(suite.env?.TEST_PARALLEL_DEADLINE_MS)
    expect((job["timeout-minutes"] ?? 0) * 60_000 - deadline).toBe(600_000)
    return
  }
  throw new Error("no shard step runs test-sandbox.ts")
})
