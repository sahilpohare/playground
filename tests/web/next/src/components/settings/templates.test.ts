import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { HARNESSES } from "../../../../../../packages/settings/src/harnesses"
import { BACKENDS, Templates } from "../../../../../../web/next/src/components/settings/templates"
import { ACCOUNTS_QUERY_KEY } from "../../../../../../web/next/src/lib/accounts"
import {
  type Template,
  TEMPLATE_SETTING_QUERY_KEY,
} from "../../../../../../web/next/src/lib/templates"

type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}
const { QueryClient, QueryClientProvider } = (await import(
  Bun.resolveSync("@tanstack/react-query", web)
)) as {
  QueryClient: new () => { setQueryData: (key: readonly unknown[], data: unknown) => void }
  QueryClientProvider: unknown
}

const ORCHESTRATOR: Template = {
  brief: "orchestrator.md",
  harness: "claude-code",
  id: "orchestrator",
  kind: "orchestrator",
  label: "Orchestrator",
}
const ASSISTANT: Template = {
  brief: "assistant.md",
  harness: "claude-code",
  id: "assistant",
  kind: "assistant",
  label: "Assistant",
}
const NIGHT: Template = {
  brief: "night.md",
  harness: "claude-code",
  id: "night-shift",
  kind: "orchestrator",
  label: "Night shift",
  model: "glm",
}

const render = (rows?: Template[], scope: string | null = "made-up-me") => {
  const client = new QueryClient()
  client.setQueryData(ACCOUNTS_QUERY_KEY, { accounts: [], login: scope !== null, scope })
  if (rows)
    client.setQueryData(TEMPLATE_SETTING_QUERY_KEY, { defaults: [ASSISTANT, ORCHESTRATOR], rows })
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Templates)),
  )
}

describe("Settings > Templates", () => {
  test("is the section the picker's Edit templates lands on, at #templates", () => {
    const html = render([ASSISTANT, ORCHESTRATOR])
    expect(html).toContain('id="templates"')
    expect(html).toContain(">Templates<")
    expect(html).toContain(">Add template<")
  })

  test("each row says whether it is a default, an edited default or one you added, with Reset on an edited one and Remove on an added one", () => {
    const html = render([ASSISTANT, NIGHT, { ...ORCHESTRATOR, effort: "high" }])
    expect(html).toContain("Default · Assistant · Claude · assistant.md")
    expect(html).toContain("Added · Orchestrator · GLM · night.md")
    expect(html).toContain("Edited default · Orchestrator · Claude · High · orchestrator.md")
    for (const label of ["Assistant", "Night shift", "Orchestrator"])
      expect(html).toContain(`aria-label="Edit ${label}"`)
    expect(html).toContain('aria-label="Reset Orchestrator"')
    expect(html).toContain('aria-label="Remove Night shift"')
    expect(html).not.toContain('aria-label="Reset Assistant"')
    expect(html).not.toContain('aria-label="Remove Assistant"')
    expect(html).not.toContain('aria-label="Remove Orchestrator"')
  })

  test("while the first read is pending, it holds an empty busy slot", () => {
    const html = render()
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain("No templates")
  })

  test("before the extensions login names a scope to write to, every action is disabled", () => {
    const html = render([NIGHT], null)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\s*Add template/)
    expect(html).toMatch(/<button(?=[^>]*aria-label="Edit Night shift")(?=[^>]*disabled="")/)
  })

  test("a default missing from a list saved before it was added shows as a new default with Add, and no Edit until it is in", () => {
    const html = render([ASSISTANT])
    expect(html).toContain("New default · Orchestrator · Claude · orchestrator.md")
    expect(html).toContain('aria-label="Add Orchestrator"')
    expect(html).not.toContain('aria-label="Edit Orchestrator"')
    expect(html).toContain('aria-label="Edit Assistant"')
  })

  test("a list holding every default shows no new default", () => {
    const html = render([ASSISTANT, NIGHT, ORCHESTRATOR])
    expect(html).not.toContain("New default")
    expect(html).not.toContain('aria-label="Add ')
  })

  test("before a scope is named, a new default's Add is disabled too", () => {
    const html = render([ASSISTANT], null)
    expect(html).toMatch(/<button(?=[^>]*aria-label="Add Orchestrator")(?=[^>]*disabled="")/)
  })
})

describe("how a new default appears, in the dialog and the docs", () => {
  const read = (path: string) => Bun.file(join(import.meta.dir, "../../../../../..", path)).text()

  test("the dialog's description and the settings docs say a default added later shows as New default, with Add", async () => {
    const dialog = await read("web/next/src/components/settings/templates.tsx")
    const docs = await read("web/next/content/docs/settings.mdx")
    expect(dialog).toContain(
      "A default Playground adds later shows in the list as New default, and Add puts it in.",
    )
    expect(docs).toContain(
      "a default Playground adds later shows as **New default**, and **Add** puts it in your list with your edits kept",
    )
    for (const text of [dialog, docs]) expect(text).not.toContain("back to the defaults alone")
  })
})

test("the form's backends are Claude Code's, as the settings package lists them", () => {
  const claudeCode = HARNESSES.filter((h) => h.id === "claude-code").flatMap((h) => h.backends)
  expect(BACKENDS.map((option) => option.value)).toEqual(claudeCode)
})
