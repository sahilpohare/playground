import { describe, expect, test } from "bun:test"

import { GLM_MODEL as SETTINGS_GLM_MODEL } from "../../../../../packages/settings/src/harnesses"
import {
  GLM_MODEL,
  newDefaults,
  newTemplateId,
  resetTemplate,
  type Template,
  TEMPLATE_KINDS,
  TEMPLATE_STATE_WORDS,
  templateForm,
  templateOf,
  templateRefusal,
  type TemplateRow,
  templateRowView,
  templatesWrite,
  templateState,
  templateWords,
  withoutTemplate,
  withTemplate,
} from "../../../../../web/next/src/lib/templates"

const row = (over: Partial<TemplateRow>): TemplateRow => ({
  effort: null,
  harness: "claude-code",
  id: "orchestrator",
  kind: "orchestrator",
  label: "Orchestrator",
  model: null,
  refusal: null,
  ...over,
})

describe("a template picker row", () => {
  test("a row a gate refuses is disabled with the API's reason in place of its detail", () => {
    const claude = row({
      id: "second-dispatcher-claude",
      kind: "dispatcher",
      label: "Second dispatcher on Claude",
      refusal: "Add a second Claude account in Settings > Accounts",
    })
    expect(templateRowView(claude, false)).toEqual({
      detail: "Claude",
      label: "Second dispatcher on Claude",
      reason: "Add a second Claude account in Settings > Accounts",
    })
  })

  test("a dispatcher template is disabled while the second dispatcher runs; an orchestrator is not", () => {
    const glm = row({ id: "second-dispatcher-glm", kind: "dispatcher", model: "glm" })
    expect(templateRowView(glm, true).reason).toBe("The second dispatcher is running")
    expect(templateRowView(glm, false).reason).toBeNull()
    expect(templateRowView(row({}), true).reason).toBeNull()
  })

  test("its detail is its backend or model, then its effort", () => {
    expect(templateRowView(row({ model: "glm" }), false).detail).toBe("GLM")
    expect(templateRowView(row({ effort: "high", model: "opus" }), false).detail).toBe(
      "opus · High",
    )
  })
})

// The defaults as packages/settings/src/sessions.ts holds them.
const DEFAULTS: Template[] = [
  {
    brief: "assistant.md",
    harness: "claude-code",
    id: "assistant",
    kind: "assistant",
    label: "Assistant",
  },
  {
    brief: "orchestrator.md",
    harness: "claude-code",
    id: "orchestrator",
    kind: "orchestrator",
    label: "Orchestrator",
  },
  {
    brief: "dispatcher-2.md",
    harness: "claude-code",
    id: "second-dispatcher-claude",
    kind: "dispatcher",
    label: "Second dispatcher on Claude",
  },
  {
    brief: "dispatcher-2.md",
    harness: "claude-code",
    id: "second-dispatcher-glm",
    kind: "dispatcher",
    label: "Second dispatcher on GLM",
    model: "glm",
  },
]
const orchestrator = DEFAULTS[1]!

describe("the template editor", () => {
  test("saving an edit puts it in its default's place, read as an edited default, and writes the list", () => {
    const edited = templateOf(
      { ...templateForm(orchestrator), effort: "high", model: "opus" },
      orchestrator.id,
    )
    expect(edited).toEqual({ ...orchestrator, effort: "high", model: "opus" })
    const rows = withTemplate(DEFAULTS, edited)
    expect(rows.map((row) => row.id)).toEqual(DEFAULTS.map((row) => row.id))
    expect(rows.map((row) => templateState(row, DEFAULTS))).toEqual([
      "default",
      "edited",
      "default",
      "default",
    ])
    expect(templatesWrite(rows, DEFAULTS, DEFAULTS)).toEqual({ value: rows })
    expect(templateWords(edited)).toBe("Orchestrator · Opus · High · orchestrator.md")
  })

  test("reset puts a default's own values back, and a list of the defaults alone resets the setting", () => {
    const rows = withTemplate(DEFAULTS, { ...orchestrator, brief: "night.md" })
    const reset = resetTemplate(rows, orchestrator.id, DEFAULTS)
    expect(reset).toEqual(DEFAULTS)
    expect(templatesWrite(reset, rows, DEFAULTS)).toEqual({ reset: true })
  })

  test("a save that changes nothing writes nothing, so a default saved as it is never asks for a reset the setting does not hold", () => {
    const unchanged = withTemplate(
      DEFAULTS,
      templateOf(templateForm(orchestrator), orchestrator.id),
    )
    expect(templatesWrite(unchanged, DEFAULTS, DEFAULTS)).toEqual({ none: true })
    const stored = withTemplate(DEFAULTS, { ...orchestrator, effort: "high" })
    expect(
      templatesWrite(withTemplate(stored, { ...orchestrator, effort: "high" }), stored, DEFAULTS),
    ).toEqual({
      none: true,
    })
  })

  test("an added template takes a fresh id from its label, sorts by label, and Remove takes it away while a default stays", () => {
    const form = { ...templateForm(), brief: "night.md", label: "Night shift" }
    const added = templateOf(form, newTemplateId(form.label, DEFAULTS))
    expect(added).toEqual({
      brief: "night.md",
      harness: "claude-code",
      id: "night-shift",
      kind: "orchestrator",
      label: "Night shift",
    })
    const rows = withTemplate(DEFAULTS, added)
    expect(rows.map((row) => row.label)).toEqual([
      "Assistant",
      "Night shift",
      "Orchestrator",
      "Second dispatcher on Claude",
      "Second dispatcher on GLM",
    ])
    expect(templateState(added, DEFAULTS)).toBe("added")
    expect(newTemplateId("Night shift", rows)).toBe("night-shift-2")
    expect(templatesWrite(rows, DEFAULTS, DEFAULTS)).toEqual({ value: rows })
    expect(withoutTemplate(rows, "night-shift", DEFAULTS)).toEqual(DEFAULTS)
    expect(withoutTemplate(rows, "orchestrator", DEFAULTS)).toEqual(rows)
  })

  test("a GLM template saves glm as its model, without Claude's account, effort and model", () => {
    const form = {
      ...templateForm(orchestrator),
      account: "pat@example.com",
      effort: "high",
      model: "opus",
    }
    expect(templateOf({ ...form, backend: "glm" }, "orchestrator")).toEqual({
      ...orchestrator,
      model: "glm",
    })
    expect(templateForm(DEFAULTS[3])).toMatchObject({ backend: "glm", model: "" })
  })

  // Each refusal is the settings write's own words, which tests/packages/settings/src/sessions.test.ts holds the same.
  test("a bad brief's refusal shows beside the brief of the template saved", () => {
    expect(
      templateRefusal(
        "sessions.templates: ✖ a brief is a file name, with no /   → at [0].brief",
        0,
      ),
    ).toEqual({ fields: { brief: "a brief is a file name, with no /" }, rest: null })
  })

  test("an unknown account's refusal shows beside the account, and one at another template shows whole", () => {
    const message =
      "sessions.templates: ✖ sam@example.com is not in usage.accounts: add it in Settings > Accounts   → at [1].account"
    expect(templateRefusal(message, 1)).toEqual({
      fields: {
        account: "sam@example.com is not in usage.accounts: add it in Settings > Accounts",
      },
      rest: null,
    })
    expect(templateRefusal(message, 0)).toEqual({
      fields: {},
      rest: "sam@example.com is not in usage.accounts: add it in Settings > Accounts   → at [1].account",
    })
  })

  test("its kinds are the roster's managers, as the settings schema lists them", () => {
    expect([...TEMPLATE_KINDS]).toEqual([
      "assistant",
      "builder",
      "dispatcher",
      "ops",
      "optimizer",
      "orchestrator",
      "planner",
    ])
  })
})

describe("a default added after a save", () => {
  const glm = DEFAULTS[3]!
  const savedBefore = DEFAULTS.filter((row) => row.id !== glm.id)

  test("a list saved before a default was added lists it as new, and Add puts it in with the other edits kept", () => {
    const stored = withTemplate(savedBefore, { ...orchestrator, effort: "high" })
    expect(newDefaults(stored, DEFAULTS)).toEqual([glm])
    expect(TEMPLATE_STATE_WORDS.new).toBe("New default")
    const added = withTemplate(stored, glm)
    expect(added).toContainEqual({ ...orchestrator, effort: "high" })
    expect(added).toContainEqual(glm)
    expect(newDefaults(added, DEFAULTS)).toEqual([])
    expect(templateState(glm, DEFAULTS)).toBe("default")
    expect(templatesWrite(added, stored, DEFAULTS)).toEqual({ value: added })
  })

  test("Add on a list with no edits brings it back to the defaults alone, so the setting resets", () => {
    expect(templatesWrite(withTemplate(savedBefore, glm), savedBefore, DEFAULTS)).toEqual({
      reset: true,
    })
  })

  test("a list of the defaults, or the defaults and one you added, has no new default", () => {
    expect(newDefaults(DEFAULTS, DEFAULTS)).toEqual([])
    const night: Template = {
      ...orchestrator,
      brief: "night.md",
      id: "night-shift",
      label: "Night shift",
    }
    expect(newDefaults(withTemplate(DEFAULTS, night), DEFAULTS)).toEqual([])
  })
})

test("the web's GLM model is the settings package's", () => {
  expect(GLM_MODEL).toBe(SETTINGS_GLM_MODEL)
})
