import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../../..")
const SKILL = join(ROOT, "extensions/core/skills/pr")
const UPSTREAM = join(import.meta.dir, "upstream")

const TLDR =
  "## TL;DR\n\n- <a few short bullet points by the plain-words skill: what changes, and why>\n\n"
const LINKS =
  "\n\n## Links\n\n<tickets, issues it closes, docs, related PRs; a ship-now PR not titled fix( adds a line opening Owner ask: with the owner's Inbox #i id, PG issue or quoted words>"

// The skill is upstream's whole, with only a few blocks Playground added: a TL;DR on top of the template, an Evidence note the gates read, and a Links block at its end. Every edit beyond them is drift, and the pinned copy is upstream's at the commit upstream/mattpocock/SOURCE names, so the test needs no network.
const EVIDENCE =
  "\n\nA PR whose code reads live machine state (a model server, herdr, docker, a systemd unit, the usage files) also gives one read of that code on the live layout, as a read-only run, with its output, not only the injected stub."

// The three anchors the file splits on: the Summary fence, the Evidence intro, and the Merge Danger fence, each appearing once so the file splits into exactly its known pieces.
const top = "```markdown\n## Summary"
const evidence = "Concrete evidence that the change works. Show a before and after."
const end = "<optional: potential ramifications of merge>\n```"
describe("the pr skill", () => {
  test("is upstream's SKILL.md with a TL;DR, an Evidence note and a Links block added, nothing else", async () => {
    const upstream = await Bun.file(join(UPSTREAM, "SKILL.md")).text()
    expect(upstream.split(top)).toHaveLength(2)
    expect(upstream.split(evidence)).toHaveLength(2)
    expect(upstream.split(end)).toHaveLength(2)
    const expected = upstream
      .replace(top, `\`\`\`markdown\n${TLDR}## Summary`)
      .replace(evidence, `${evidence}${EVIDENCE}`)
      .replace(end, `<optional: potential ramifications of merge>${LINKS}\n\`\`\``)
    expect(await Bun.file(join(SKILL, "SKILL.md")).text()).toBe(expected)
  })

  test("keeps upstream's CREDITS.md byte for byte", async () => {
    expect(await Bun.file(join(SKILL, "CREDITS.md")).text()).toBe(
      await Bun.file(join(UPSTREAM, "CREDITS.md")).text(),
    )
  })

  test("its Links line holds no `#n` placeholder", async () => {
    const text = await Bun.file(join(SKILL, "SKILL.md")).text()
    expect(text).not.toMatch(/#n\b/)
  })
})
