import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as bodyGate from "../../../../../packages/scripts/src/pr-merge/body"
import { bodyRefusal, templateBody } from "../../../../../packages/scripts/src/pr-merge/body"
import { SKILL_BODY } from "./bodies"

describe("templateBody", () => {
  test("takes a TL;DR of 2 sentences first, then Summary, Evidence, Merge Danger and Links in order", () => {
    expect(templateBody(SKILL_BODY)).toBe(true)
    expect(templateBody(`${SKILL_BODY}\n\n🤖 Generated with Claude Code`)).toBe(true)
    expect(templateBody(SKILL_BODY.replace("The board", "Outcome: The board"))).toBe(true)
  })

  test("takes a TL;DR of bullets, 2 sentences or more across them, with or without a closing stop, and no upper count", () => {
    const bullets = (...items: string[]) =>
      SKILL_BODY.replace(
        "The board shows each PR once. You see one row for each PR.",
        items.join("\n"),
      )
    expect(
      templateBody(bullets("- The board shows each PR once", "- You see one row for each PR.")),
    ).toBe(true)
    expect(templateBody(bullets("- One.", "- Two.", "- Three.", "- Four.", "- Five."))).toBe(true)
    expect(
      templateBody(bullets("Outcome: The board reads right.", "", "- It shows each PR once")),
    ).toBe(true)
    expect(templateBody(bullets("- The board shows each PR once"))).toBe(false)
    const crlf = bullets("- The board shows each PR once", "- You see one row for each PR")
    expect(templateBody(crlf.replace(/\n/g, "\r\n"))).toBe(true)
  })

  test("reads a heading inside a code fence as a sample, and takes ## TLDR as ## TL;DR", () => {
    const sample = SKILL_BODY.replace(
      "The board reads each PR once.",
      "The board reads each PR once.\n\n```markdown\n## Links\n## Summary\n```",
    )
    expect(templateBody(sample)).toBe(true)
    expect(templateBody(SKILL_BODY.replace("## TL;DR", "## TLDR"))).toBe(true)
  })

  test("refuses a short TL;DR, anything above it, a missing section, or the sections out of order", () => {
    expect(templateBody(SKILL_BODY.replace(" You see one row for each PR.", ""))).toBe(false)
    expect(templateBody(`Outcome: one. Two.\n\n${SKILL_BODY}`)).toBe(false)
    expect(templateBody(SKILL_BODY.replace("## TL;DR\n\n", ""))).toBe(false)
    expect(templateBody(SKILL_BODY.replace("## Links", "## See also"))).toBe(false)
    const swapped = SKILL_BODY.replace("## Evidence", "## X")
      .replace("## Merge Danger", "## Evidence")
      .replace("## X", "## Merge Danger")
    expect(templateBody(swapped)).toBe(false)
  })
})

describe("bodyRefusal", () => {
  test("takes a PR template body, its TL;DR in prose or bullets", () => {
    expect(bodyRefusal(SKILL_BODY)).toBeNull()
    const bulletsOnly = SKILL_BODY.replace(
      "The board shows each PR once. You see one row for each PR.",
      "- The board shows each PR once\n- You see one row for each PR",
    )
    expect(bodyRefusal(bulletsOnly)).toBeNull()
  })

  test("refuses a body that is not the template, a labelled paragraph included", () => {
    expect(bodyRefusal("Outcome: One. Two.\n")).toContain("needs the PR template")
    expect(bodyRefusal("## What changes\n- a.")).toContain("needs the PR template")
  })

  test("refuses an Outcome label line in the TL;DR, naming it", () => {
    expect(bodyRefusal(SKILL_BODY.replace("The board", "Outcome: The board"))).toContain(
      'labelled "Outcome:"',
    )
    expect(bodyRefusal(SKILL_BODY.replace("The board", "**Outcome:** The board"))).toContain(
      'labelled "Outcome:"',
    )
    const bullet = SKILL_BODY.replace(
      "The board shows each PR once. You see one row for each PR.",
      "- Outcome: the board reads right\n- It shows each PR once",
    )
    expect(bodyRefusal(bullet)).toContain("extensions/core/skills/pr/SKILL.md")
    for (const line of [
      "> Outcome: The board",
      "1. Outcome: The board",
      "### Why\n\nOutcome: The board",
    ]) {
      expect(bodyRefusal(SKILL_BODY.replace("The board", line))).toContain('labelled "Outcome:"')
    }
  })

  test("takes a label outside the TL;DR, and prose that only starts like one", () => {
    expect(
      bodyRefusal(SKILL_BODY.replace("The board reads each PR once.", "Outcome: one row.")),
    ).toBeNull()
    expect(bodyRefusal(SKILL_BODY.replace("The board", "Outcomes vary. The board"))).toBeNull()
  })
})

// PG-693: .agents/shipping.md asks the Evidence to name each touched doc, and the gate now reads it
describe("bodyRefusal, given the PR's changed files", () => {
  const named = (line: string) =>
    SKILL_BODY.replace(
      "- **Before:** two rows. **After:** one.",
      `- **Before:** two rows. **After:** one.\n${line}`,
    )

  test("refuses a changed doc the Evidence leaves out, naming its path", () => {
    const why = bodyRefusal(SKILL_BODY, ["scripts/README.md", "scripts/ops/run-slot.sh"])
    expect(why).toContain("scripts/README.md")
    expect(why).not.toContain("run-slot.sh")
  })

  test("takes the same body once its Evidence names that path", () => {
    expect(
      bodyRefusal(named("- **Docs:** `scripts/README.md`, checked by doc-sync."), [
        "scripts/README.md",
      ]),
    ).toBeNull()
  })

  test("takes a PR that changes no doc, as before", () => {
    expect(bodyRefusal(SKILL_BODY, ["packages/scripts/src/x.ts"])).toBeNull()
    expect(bodyRefusal(SKILL_BODY, [])).toBeNull()
  })

  test("reads a SKILL.md as a doc, and names each one left out", () => {
    const why = bodyRefusal(SKILL_BODY, [
      "extensions/core/skills/pr/SKILL.md",
      "docs/playground/pr.md",
    ])
    expect(why).toContain("extensions/core/skills/pr/SKILL.md")
    expect(why).toContain("docs/playground/pr.md")
  })

  // review round 1: the Evidence section is read as templateBody reads it, so a ## line inside a code fence is a sample, not a heading
  test("reads past a fenced ## sample, in the Evidence or before it", () => {
    const fence = "```"
    const inEvidence = named(`${fence}md\n## x\n${fence}\n- \`README.md\` checked.`)
    expect(bodyRefusal(inEvidence, ["README.md"])).toBeNull()
    const inSummary = named("- `README.md` checked.").replace(
      "The board reads each PR once.",
      `The board reads each PR once.\n\n${fence}md\n## Evidence\n\nnone\n${fence}`,
    )
    expect(bodyRefusal(inSummary, ["README.md"])).toBeNull()
  })

  test("counts a path as named only in the Evidence, and only whole", () => {
    const summary = SKILL_BODY.replace(
      "The board reads each PR once.",
      "The board reads `README.md` once.",
    )
    expect(bodyRefusal(summary, ["README.md"])).toContain("README.md")
    expect(bodyRefusal(named("- `scripts/README.md` changes."), ["README.md"])).toContain(
      "README.md",
    )
    expect(bodyRefusal(named("- `README.md.bak` changes."), ["README.md"])).toContain("README.md")
    expect(
      bodyRefusal(named("- README.md, then AGENTS.md:12."), ["README.md", "AGENTS.md"]),
    ).toBeNull()
  })
})

// #1476: every PR states its measured comparison, so the gate reads an A/B line in the Evidence
describe("bodyRefusal, reading the Evidence's A/B line", () => {
  const AB = "- A/B: rows a PR shows, A canary 2, B branch 1, n=12 against a bar of 1"
  const without = SKILL_BODY.replace(`${AB}\n`, "")

  test("takes a body whose Evidence holds an A/B line, as a bullet, in bold or as plain text", () => {
    expect(bodyRefusal(SKILL_BODY)).toBeNull()
    for (const line of [
      "A/B: rows a PR shows, A canary 2, B branch 1, n=12",
      "**A/B:** rows a PR shows, A canary 2, B branch 1, n=12",
      "- **A/B**: rows a PR shows, A canary 2, B branch 1, n=12",
      "* __A/B:__ rows a PR shows, A canary 2, B branch 1, n=12",
    ])
      expect(bodyRefusal(SKILL_BODY.replace(AB, line))).toBeNull()
  })

  test("refuses a body whose Evidence holds no A/B line, naming the fix", () => {
    const why = bodyRefusal(without)
    expect(why).toContain("A/B:")
    expect(why).toContain("No runtime metric")
  })

  test("takes A/B: No runtime metric with the check that stands in", () => {
    expect(
      bodyRefusal(SKILL_BODY.replace(AB, "- A/B: No runtime metric; docs-wrap --check stands in")),
    ).toBeNull()
  })

  test("reads the line only in the Evidence, outside a code fence, at the start of its line", () => {
    const inSummary = without.replace(
      "The board reads each PR once.",
      `The board reads each PR once.\n\n${AB}`,
    )
    expect(bodyRefusal(inSummary)).toContain("A/B:")
    const fenced = without.replace("- **Before:**", `\`\`\`text\n${AB}\n\`\`\`\n- **Before:**`)
    expect(bodyRefusal(fenced)).toContain("A/B:")
    expect(bodyRefusal(without.replace("**After:** one.", "**After:** one, A/B: none."))).toContain(
      "A/B:",
    )
  })
})

// PG-2493: an Evidence line still reading TBD cost a review round each on #2482 and #2462, so the gate refuses it before round 1
describe("bodyRefusal, reading TBD in the Evidence", () => {
  const BEFORE = "- **Before:** two rows. **After:** one."
  const evidence = (line: string) => SKILL_BODY.replace(BEFORE, `${BEFORE}\n${line}`)

  test("refuses TBD in any case in the Evidence, naming its line", () => {
    for (const word of ["TBD", "tbd", "Tbd"]) {
      const line = `- Touched tests: ${word}`
      expect(bodyRefusal(evidence(line))).toBe(
        `its body's Evidence holds TBD: "${line}"; write what was measured, or say what is pending and when`,
      )
    }
  })

  test("passes TBD outside the Evidence", () => {
    expect(
      bodyRefusal(
        SKILL_BODY.replace(
          "The board reads each PR once.",
          "The board reads each PR once; its colour is TBD.",
        ),
      ),
    ).toBeNull()
    expect(
      bodyRefusal(
        SKILL_BODY.replace("**Blast Radius:** board", "**Blast Radius:** board, its reach TBD"),
      ),
    ).toBeNull()
  })

  test("passes an Evidence line that says a check is pending after merge", () => {
    expect(
      bodyRefusal(
        evidence("- The ship's smoke test: pending after merge, read by the merge train."),
      ),
    ).toBeNull()
  })

  test("passes TBD in inline code or a fence in the Evidence, and a word that only holds it", () => {
    expect(bodyRefusal(evidence("- The gate now refuses `TBD` here."))).toBeNull()
    expect(bodyRefusal(evidence("```text\nTBD\n```"))).toBeNull()
    expect(bodyRefusal(evidence("- TBDs and xtbd are other words."))).toBeNull()
  })

  test("refuses a line that names `TBD` in inline code and still says TBD as bare text", () => {
    const line = "- The gate refuses `TBD`; this line's own count is still TBD."
    expect(bodyRefusal(evidence(line))).toBe(
      `its body's Evidence holds TBD: "${line}"; write what was measured, or say what is pending and when`,
    )
  })
})

describe("bodyRefusal, reading an unfilled placeholder", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pr-merge-body-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", scratch, ...args])
  git("init", "-q")
  writeFileSync(join(scratch, "clock.ts"), "export const CLOCK_EXEMPT = []\n")
  git("add", "clock.ts")
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "a")
  // Whether the scratch repo's head holds the word, as git grep -w reads the PR's head.
  const known = (token: string) => git("grep", "-q", "-w", "-F", token, "HEAD").exitCode === 0
  // The facts the gate reads for a body: the template's placeholders, and its tokens the scratch head does not hold.
  const check = (body: string) => ({
    placeholders: ["<one-way or two-way>"],
    unfound: (bodyGate.bareTokens?.(body) ?? []).filter((token: string) => !known(token)),
  })
  const refusal = (body: string) => bodyRefusal(body, [], check(body))
  const withLine = (line: string) =>
    SKILL_BODY.replace("- **Before:** two rows.", `- ${line}\n- **Before:** two rows.`)

  test("the pr template's placeholders are read from its file, inside its markdown fence alone", async () => {
    const skill = await Bun.file(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "..",
        "extensions",
        "core",
        "skills",
        "pr",
        "SKILL.md",
      ),
    ).text()
    const read = bodyGate.templatePlaceholders?.(skill) ?? []
    expect(read).toContain("<one-way or two-way>")
    expect(read).toContain("<diagram, diff-sketch, or tree>")
    expect(read.every((p: string) => /^<[^<>]+>$/.test(p))).toBe(true)
  })

  test("a body holding the pr template's own placeholder is refused, naming it", () => {
    const body = SKILL_BODY.replace("**Door:** two-way", "**Door:** <one-way or two-way>")
    expect(refusal(body)).toContain("<one-way or two-way>")
  })

  test("a body holding a bare all-caps token that no file at the head holds is refused, naming it", () => {
    expect(refusal(withLine("**Green:** SUITE_LINE"))).toContain("SUITE_LINE")
  })

  test("a bare all-caps token that a file at the head holds passes", () => {
    expect(refusal(withLine("The pass leaves out CLOCK_EXEMPT's files."))).toBeNull()
  })

  // a code span stays on its line, as Markdown renders a list, so a stray backtick hides nothing on the lines after it
  test("a stray backtick on one line leaves a later line's bare token read", () => {
    const body = withLine(
      "**Green:** the `test` job ran, it said 5` passes\n- **Skills:** SKILLS_LINE",
    )
    expect(refusal(body)).toContain("SKILLS_LINE")
  })

  test("an all-caps token in inline code or a fence passes", () => {
    expect(refusal(withLine("Fill `SUITE_LINE` later."))).toBeNull()
    expect(refusal(withLine("Sample:\n\n```\nSUITE_LINE\n```\n"))).toBeNull()
  })
})
