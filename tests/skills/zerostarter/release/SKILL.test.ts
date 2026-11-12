import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { gateLine, rehearsalLine } from "../../../../packages/scripts/src/pr-merge/ship-lines"

const ROOT = join(import.meta.dir, "../../../..")

const skill = () => Bun.file(join(ROOT, "skills/zerostarter/release/SKILL.md")).text()
const step = async (heading: string) =>
  (await skill()).match(new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## )`, "m"))?.[0] ?? ""
const step1 = () => step("1\\. Pin the content")
const step3 = () => step("3\\. Merge into `main`")

describe("the ship's merge step is ship:merge, which reads its gates at the head (#1650, #1659)", () => {
  test("step 3 merges through ship:merge alone, with no bare gh pr merge, since v0.0.82 merged with a red shard", async () => {
    const text = await step3()
    expect(text).toContain("bun run ship:merge <n>")
    expect(text).not.toContain("gh pr merge")
    expect(await Bun.file(join(ROOT, "packages/scripts/src/pr-merge/ship-merge.ts")).exists()).toBe(
      true,
    )
  })

  test("a pin with held runs under the bot's draft approves them with ship:approve-held", async () => {
    const text = await step3()
    expect(text).toContain("`action_required`")
    expect(text).toContain("`bun run ship:approve-held <n>`")
    expect(text).not.toContain("`gh pr close <n>`")
  })

  test("a red reruns once, a cancelled run whole, and a second red or a FAIL gate line holds the ship by step 1", async () => {
    const text = await step3()
    expect(text).toContain("`gh run rerun <run id> --failed`")
    expect(text).toContain("`gh run rerun <run id>`")
    expect(text).toMatch(
      /second red, or a FAIL gate line, holds the ship.*step 1's line for a ship that stops/s,
    )
  })

  test("its Done when reads ship:merge's merged line", async () => {
    const done = (await step3()).match(/^Done when .*$/m)?.[0] ?? ""
    expect(done).toContain("`merged #<n> at <sha>`")
  })
})

describe("step 1 and the rehearsal write the lines ship:merge reads, in its own words (#1659)", () => {
  test("step 1 names the gate's last line as gateLine prints it", async () => {
    const text = await step1()
    expect(text).toContain(`\`${gateLine("<sha>", false)}\``)
    expect(text).toContain(`\`${gateLine("<sha>", true)}\``)
  })

  test("the rehearsal names its line as rehearsalLine reads it, PASS or not needed", async () => {
    const text = await skill()
    expect(text).toContain(`\`${rehearsalLine("<sha>", "PASS")}\``)
    expect(text).toContain(`\`${rehearsalLine("<sha>", "not needed")}\``)
  })
})
