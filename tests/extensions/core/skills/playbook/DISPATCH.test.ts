import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const DISPATCH = join(import.meta.dir, "../../../../../extensions/core/skills/playbook/DISPATCH.md")

describe("DISPATCH.md", () => {
  test("files an org's or a person's ask in that extension's repo, and only the factory's own in the factory repo (PG-83)", async () => {
    const text = await Bun.file(DISPATCH).text()
    const lines = text.split("\n")
    const at = lines.findIndex((l) =>
      l.includes("It files an issue in the repo where the work lives"),
    )
    const line = lines[at] ?? ""
    expect(line).toContain("the factory's own work in the factory repo")
    expect(lines[at + 1]).toContain("Before it files one, it searches that repo's open issues")
    expect(line).toContain(
      "an org's in that org's extension repo and a person's in their login extension ([ADR 0016](",
    )
  })

  test("a stacked child merges its parent's branch once, when the parent scores 5/5 or merges, with its measured case", async () => {
    const text = await Bun.file(DISPATCH).text()
    const line =
      text.split("\n").find((l) => l.includes("merges its parent's branch in once")) ?? ""
    expect(line).toContain("once, when the parent scores 5/5 or merges")
    expect(line).toContain("and `canary` only when it needs it")
    expect(line).toContain("four times in 59 minutes while the parent sat at 3/5")
  })

  test("a stack held at 5/5 until the owner's try syncs with canary only on a conflict, plus once before the try, with its measured case", async () => {
    const lines = (await Bun.file(DISPATCH).text()).split("\n")
    const at = lines.findIndex((l) =>
      l.includes("A stack held at 5/5 until the owner's try syncs with `canary` only when"),
    )
    const line = lines[at] ?? ""
    expect(line).toContain(
      "GitHub reads a PR in it as conflicting or code-review-loop's step 8 finds a conflict",
    )
    expect(line).toContain("plus once more before the try, never on a schedule")
    expect(line).toContain("6,774 s")
    expect(lines[at + 1]).toContain(
      "Each sync's round waits on CI at the synced head and cites it where code-review-loop's The last 5/5 lets CI stand in",
    )
    expect(lines[at + 2]).toContain(
      "A sync is done when each PR in the stack has its merged head pushed and its reviewer has posted a verdict at that head",
    )
    expect(lines[at + 3]).toContain(
      "The owner's try is the owner's own run of a stack before any PR in it merges, which the lead names with its time to each reviewer in the stack, so each knows its waiting 5/5 is held and which sync comes before the try",
    )
  })

  test("a lane's item aims at about 1,000 changed lines, a bigger diff splitting off canary, with its measured case", async () => {
    const text = await Bun.file(DISPATCH).text()
    const line = text.split("\n").find((l) => l.includes("aims at about 1,000 changed lines")) ?? ""
    expect(line).toContain("splits the rest into a new PR off `canary`")
    expect(line).toContain("rather than stacking a third level")
    expect(line).toContain("9,089 lines")
  })

  test("a lane's or a stack's file set and an overlap check read each PR's whole list through the paginated read, since gh pr view stops at 100", async () => {
    const lines = (await Bun.file(DISPATCH).text()).split("\n")
    const lanes = lines.findIndex((l) => l.includes("each lane owning its files"))
    const at = lines.findIndex((l) => l.includes("every overlap check between open PRs"))
    expect(at).toBeGreaterThan(lanes)
    const line = lines[at] ?? ""
    expect(line).toContain("a stack's")
    expect(line).toContain("overlap")
    expect(line).toContain(
      "`gh api --paginate repos/<owner>/<repo>/pulls/<n>/files --jq '.[].filename'`",
    )
    expect(line).toContain("`gh pr view <n> --json files` stops at 100")
    expect(line).toContain("100 of its 143 files")
  })

  test("a decision that claims no change for this machine cites its measurement, with its measured case (PG-308)", async () => {
    const lines = (await Bun.file(DISPATCH).text()).split("\n")
    const at = lines.findIndex((l) =>
      l.includes("a design choice goes in `~/.playground/bundles/decisions.md`"),
    )
    const line = lines[at + 1] ?? ""
    expect(line).toContain(
      "A decision that claims no change for this machine or for the owner's setup cites its measurement",
    )
    expect(line).toContain("the command run and its output")
    expect(line).toContain("once nearly let a web build run beside the live dashboard's Postgres")
  })

  test("a decision on an outside tool opens with a web check of its primary sources, cited by URL (PG-2523)", async () => {
    const lines = (await Bun.file(DISPATCH).text()).split("\n")
    const line = lines.find((l) =>
      l.includes("Every decision on an outside tool, model, library or setup"),
    )
    expect(line).toContain("opens with a web check of its primary sources")
    expect(line).toContain("cited by URL in the ruling beside our own measurements")
  })

  test("the pre-build signal is an update, a decision only when the ask removes or reverses the owner's own rule (PG-1350)", async () => {
    const lines = (await Bun.file(DISPATCH).text()).split("\n")
    const at = lines.findIndex((l) => l.includes("Before a lane builds one of the owner's asks"))
    const end = lines.findIndex((l, i) => i > at && /^\s*-\s/.test(l))
    const block = lines.slice(at, end === -1 ? at + 4 : end).join(" ")
    expect(block).toContain("it posts one Inbox update with two lines")
    expect(block).toContain(
      "it posts a decision in place of the update only when the ask removes or reverses the owner's own rule",
    )
    expect(block).toContain("neither the update nor the decision gates the lane")
  })
})
