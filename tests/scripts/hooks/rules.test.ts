import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import "../../../packages/settings/src/rules"
import { writeRoot } from "../../../packages/settings/src/folder"
import { extensionsDir } from "../../../packages/settings/src/rendered"
import { resolveKey } from "../../../packages/settings/src/settings"
import {
  check,
  fill,
  LIMIT,
  parseRule,
  readRules,
  render,
  ruleText,
  CORE_RULES,
  SLOT,
} from "../../../scripts/hooks/rules"

const input = (cwd = "/nowhere") =>
  JSON.stringify({ cwd, hook_event_name: "SessionStart", session_id: "s-1", source: "startup" })

// A data folder whose extensions root holds the given files, as the API's writes leave it.
const extensions = (files: Record<string, string>) => {
  const data = mkdtempSync(join(tmpdir(), "rules-hook-"))
  writeRoot(extensionsDir(data), new Map(Object.entries(files)))
  return data
}

describe("an intent file reads as its name, its decisions and its glance line", () => {
  test("the frontmatter's decisions are Inbox ids, and the first line of the body is the glance", () => {
    const rule = parseRule("glm", "---\ndecisions: [i706, i827]\n---\n\nOne line.\nTwo lines.\n")
    expect(rule).toEqual({
      decisions: ["i706", "i827"],
      glance: "One line.",
      name: "glm",
      text: "One line.\nTwo lines.",
    })
  })

  test("a file with no frontmatter cites no decision", () => {
    expect(parseRule("x", "Body.\n")).toEqual({
      decisions: [],
      glance: "Body.",
      name: "x",
      text: "Body.",
    })
  })

  test("readRules takes every rule file A to Z, a hyphen in its name read as a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-dir-"))
    writeFileSync(join(dir, "zeta.md"), "Z.\n")
    writeFileSync(join(dir, "local-page.md"), "L.\n")
    writeFileSync(join(dir, "alpha.md"), "A.\n")
    writeFileSync(join(dir, "notes.txt"), "not a rule\n")
    expect(readRules(dir).map((r) => r.name)).toEqual(["alpha", "local page", "zeta"])
  })
})

describe("a slot takes its setting's value", () => {
  test("a dotted key in braces is a slot, and a value fills it", () => {
    const values: Record<string, unknown> = { "glm.readOnlyLoad5": 15 }
    expect(fill('over {glm.readOnlyLoad5}, not {x} or {"a": 1}', (k) => values[k])).toBe(
      'over 15, not {x} or {"a": 1}',
    )
  })

  test("a slot with no value stays as written, so the gap shows", () => {
    expect(fill("{no.such}", () => undefined)).toBe("{no.such}")
  })
})

describe("the render fits SessionStart's 10,000 characters", () => {
  const rule = (name: string, glance: string) => ({ decisions: [], glance, name, text: glance })

  test("each section lists its rules as `- **name**: glance`, in the order given", () => {
    const text = render(
      [
        { rules: [rule("a", "One.")], title: "Playground's rules:" },
        { rules: [rule("b", "Three.")], title: "The acme org's rules:" },
      ],
      () => undefined,
    )
    expect(text).toContain("Playground's rules:\n\n- **a**: One.")
    expect(text.indexOf("- **a**")).toBeLessThan(text.indexOf("The acme org's rules:"))
    expect(text).toContain("- **b**: Three.")
    expect(text).not.toContain("left out")
  })

  test("a set too long ends at a whole rule, under the limit, naming how many it left out", () => {
    const many = Array.from({ length: 400 }, (_, i) => rule(`r${i}`, `${"word ".repeat(10)}.`))
    const text = render([{ rules: many, title: "T:" }], () => undefined)
    expect(text.length).toBeLessThanOrEqual(LIMIT)
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/^\d+ more rules were left out/)
  })
})

describe("playground's own rules", () => {
  const rules = readRules(CORE_RULES)

  test("every slot in a rule's file names a setting a piece defines", () => {
    for (const file of readdirSync(CORE_RULES))
      for (const [, key] of readFileSync(join(CORE_RULES, file), "utf8").matchAll(SLOT))
        expect([file, resolveKey(key!)]).toEqual([file, key])
  })

  test("every decision is an Inbox id", () => {
    for (const r of rules) for (const id of r.decisions) expect(id).toMatch(/^i\d+$/)
  })

  test("the rule files are exactly the folder's .md files", () => {
    expect(rules.map((r) => `${r.name.replaceAll(" ", "-")}.md`)).toEqual(
      readdirSync(CORE_RULES)
        .filter((f) => f.endsWith(".md"))
        .sort(),
    )
  })

  test("with the defaults, their glances fit the limit with room for an org's", async () => {
    const data = mkdtempSync(join(tmpdir(), "rules-defaults-"))
    const env = { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" }
    const out = JSON.parse((await check(input(), env)) ?? "null")
    const text: string = out.hookSpecificOutput.additionalContext
    expect(text.length).toBeLessThanOrEqual(LIMIT * 0.8)
    for (const r of rules) expect(text).toContain(`- **${r.name}**: `)
    expect(text).not.toMatch(SLOT)
  })
})

describe("the hook", () => {
  test("a session outside the factory gets nothing", async () => {
    expect(await check(input(), {})).toBeUndefined()
  })

  test("input that does not read fails open to nothing", async () => {
    expect(await check("not json", {})).toBeUndefined()
  })

  test("a machine with no extensions renders the defaults, with no refusal line", async () => {
    const data = mkdtempSync(join(tmpdir(), "rules-none-"))
    const out = await check(input(), { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" })
    const text: string = JSON.parse(out!).hookSpecificOutput.additionalContext
    expect(text).not.toContain("could not be read")
    expect(text).toContain("- **glm**: ")
  })

  test("the extensions' values fill the slots, and an org's rules, then the login's, follow core's", async () => {
    const data = extensions({
      "policy.json": JSON.stringify({
        orgs: { acme: { "glm.readOnlyLoad5": 9 } },
        schemaVersion: 1,
        values: { "ext.links": { acme: ["*"] }, "ext.order": ["acme"], "glm.readOnlyLoad5": 12 },
      }),
      "acme/rules/hush.md": "---\ndecisions: [i1]\n---\n\nKeep acme's work quiet.\n",
      "other/rules/loud.md": "Not this org's.\n",
      "merritt/rules/mine.md": "Mine holds over {glm.readOnlyLoad5}.\nA second line, not shown.\n",
    })
    const env = {
      PLAYGROUND_DATA_DIR: data,
      PLAYGROUND_LOGIN: "merritt",
      PLAYGROUND_ROLE: "worker",
    }
    const out = await check(input(), env)
    const text: string = JSON.parse(out!).hookSpecificOutput.additionalContext
    expect(text).toContain("- **mine**: Mine holds over 12.")
    expect(text).not.toContain("second line")
    expect(text).toContain("- **hush**: Keep acme's work quiet.")
    expect(text).not.toContain("loud")
    expect(text.indexOf("- **glm**")).toBeLessThan(text.indexOf("- **hush**"))
    expect(text.indexOf("- **hush**")).toBeLessThan(text.indexOf("- **mine**"))
  })

  // A data folder whose acme extension, linked to the acme-inc org, holds one rule, and a home holding acme-inc's own folder with a repo inside it and a folder named for no org; none is a git checkout, so none has an origin.
  const orgHome = () => {
    const data = extensions({
      "policy.json": JSON.stringify({
        orgs: {},
        schemaVersion: 1,
        values: { "ext.links": { acme: ["acme-inc"] }, "ext.order": ["acme"] },
      }),
      "acme/rules/hush.md": "Keep acme's work quiet.\n",
    })
    const home = mkdtempSync(join(tmpdir(), "rules-home-"))
    for (const folder of ["acme-inc/web", "other"])
      mkdirSync(join(home, folder), { recursive: true })
    const env = { HOME: home, PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" }
    return async (folder: string) =>
      JSON.parse((await check(input(join(home, folder)), env))!).hookSpecificOutput
        .additionalContext as string
  }

  test("a session in an org's own folder in the home folder, or a folder inside it, with no origin, gets that org's rules", async () => {
    const glance = orgHome()
    expect(await glance("acme-inc")).toContain("- **hush**: Keep acme's work quiet.")
    expect(await glance("acme-inc/web")).toContain("- **hush**: Keep acme's work quiet.")
  })

  test("a session in a folder with no origin outside every org's own folder gets no org's rules", async () => {
    const text = await orgHome()("other")
    expect(text).toContain("- **glm**: ")
    expect(text).not.toContain("**hush**")
  })

  test("with no login, no login's rules render", async () => {
    const data = extensions({ "policy.json": "{}", "merritt/rules/mine.md": "Mine.\n" })
    const out = await check(input(), { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" })
    expect(JSON.parse(out!).hookSpecificOutput.additionalContext).not.toContain("**mine**")
  })

  test("the login's rules come from the extensions' login file as from PLAYGROUND_LOGIN", async () => {
    const data = extensions({
      login: "merritt\n",
      "policy.json": "{}",
      "merritt/rules/mine.md": "Mine.\n",
    })
    const out = await check(input(), { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" })
    expect(JSON.parse(out!).hookSpecificOutput.additionalContext).toContain("- **mine**: Mine.")
  })

  test("core's rules come from the checkout, never from the extensions root", async () => {
    const data = extensions({ "core/rules/only.md": "Not core's.\n", "policy.json": "{}" })
    const out = await check(input(), { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" })
    const text: string = JSON.parse(out!).hookSpecificOutput.additionalContext
    expect(text).not.toContain("**only**")
    expect(text).toContain("- **glm**: ")
  })

  test("extensions that cannot be read render the defaults and lead with the refusal", async () => {
    const data = extensions({ "acme/rules/hush.md": "Hush.\n" })
    const out = await check(input(), { PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" })
    const text: string = JSON.parse(out!).hookSpecificOutput.additionalContext
    expect(text.split("\n")[0]).toContain("holds no policy.json")
    expect(text).toContain("- **glm**: ")
  })
})

describe("one rule whole", () => {
  test("ruleText gives the rule's every line, its slots filled, the login's over core's", async () => {
    const data = extensions({
      "policy.json": JSON.stringify({ schemaVersion: 1, values: { "glm.readOnlyLoad5": 12 } }),
      "merritt/rules/glm.md": "Mine.\nOver {glm.readOnlyLoad5}.\n",
    })
    const env = { PLAYGROUND_DATA_DIR: data, PLAYGROUND_LOGIN: "merritt" }
    expect(await ruleText("glm", "/nowhere", env)).toBe("**glm**\n\nMine.\nOver 12.")
  })

  test("core's rule reads whole with the defaults, and a name no scope holds gives nothing", async () => {
    const data = mkdtempSync(join(tmpdir(), "rules-whole-"))
    const env = { PLAYGROUND_DATA_DIR: data }
    const text = await ruleText("glm", "/nowhere", env)
    expect(text).toContain("**glm**")
    expect(text).toContain("over 15")
    expect(text).not.toMatch(SLOT)
    expect(await ruleText("no such", "/nowhere", env)).toBeUndefined()
  })
})
