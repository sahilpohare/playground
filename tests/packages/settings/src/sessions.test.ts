import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ROSTER_KINDS, ROSTER_ROLE_OF_KIND } from "../../../../packages/config/src/kinds"
import {
  CORE,
  readSessionNames,
  readSessionTemplates,
  readSetting,
  sessionSettings,
  sessionTemplates,
  settingsFor,
  setSetting,
  storedTemplates,
  TEMPLATE_KINDS,
  templateBackend,
} from "../../../../packages/settings/src"

const scratch = mkdtempSync(join(tmpdir(), "session-names-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const DEFAULTS = {
  aliases: {},
  names: { builder: "builder", dispatcher: "dispatcher", ops: "ops", planner: "planner" },
}

test("a fresh machine's extensions, with no policy.json written yet, read the default names", () => {
  const data = join(scratch, "fresh")
  mkdirSync(join(data, "extensions", "made-up-me"), { recursive: true })
  writeFileSync(join(data, "extensions", "login"), "made-up-me\n")
  expect(readSessionNames(data)).toEqual(DEFAULTS)
})

test("a policy.json that is there and does not parse is a refusal, never the defaults", () => {
  const data = join(scratch, "broken")
  mkdirSync(join(data, "extensions"), { recursive: true })
  writeFileSync(join(data, "extensions", "policy.json"), "{")
  expect(() => readSessionNames(data)).toThrow("policy.json does not parse")
})

test("a policy.json's names are the machine's", () => {
  const data = join(scratch, "named")
  mkdirSync(join(data, "extensions"), { recursive: true })
  const names = { builder: "maker", dispatcher: "boss", ops: "keeper", planner: "thinker" }
  writeFileSync(
    join(data, "extensions", "policy.json"),
    JSON.stringify({ values: { "sessions.names": names } }),
  )
  expect(readSessionNames(data)).toEqual({ aliases: {}, names })
})

describe("sessions.templates", () => {
  const defaults = () => readSessionTemplates(mkdtempSync(join(scratch, "templates-")))

  test("the defaults are Assistant, Orchestrator and a second dispatcher on Claude and on GLM, with no email in any", () => {
    expect(defaults().map((t) => t.label)).toEqual([
      "Assistant",
      "Orchestrator",
      "Second dispatcher on Claude",
      "Second dispatcher on GLM",
    ])
    expect(defaults().some((t) => t.account)).toBe(false)
  })

  test.each(["../secrets.md", "briefs/builder.md", "/etc/passwd", "a..md"])(
    "the schema refuses the brief %s, so no path leaves the brief folders",
    (brief) => {
      const orchestrator = defaults().find((t) => t.id === "orchestrator")!
      expect(sessionTemplates.safeParse([{ ...orchestrator, brief }]).success).toBe(false)
    },
  )

  test("its kinds are the roster's manager kinds, written out so settings imports no other package at run time", () => {
    expect<string[]>([...TEMPLATE_KINDS]).toEqual(
      ROSTER_KINDS.filter((kind) => ROSTER_ROLE_OF_KIND[kind] === "manager"),
    )
  })

  test("the schema refuses an id listed twice, and a GLM template with an account or an effort", () => {
    const [assistant, , , glm] = defaults()
    expect(sessionTemplates.safeParse([assistant, assistant]).success).toBe(false)
    expect(sessionTemplates.safeParse([{ ...glm!, account: "someone@example.com" }]).success).toBe(
      false,
    )
    expect(sessionTemplates.safeParse([{ ...glm!, effort: "low" }]).success).toBe(false)
  })

  test("the Orchestrator is the seatless orchestrator kind, and the second dispatchers take their own brief", () => {
    const byId = new Map(defaults().map((t) => [t.id, t]))
    expect(byId.get("orchestrator")).toMatchObject({
      brief: "orchestrator.md",
      kind: "orchestrator",
    })
    expect(byId.get("second-dispatcher-claude")?.brief).toBe("dispatcher-2.md")
    expect(byId.get("second-dispatcher-glm")?.brief).toBe("dispatcher-2.md")
  })
})

describe("a list saved before the harness split", () => {
  const old = [
    { backend: "claude", brief: "orchestrator.md", id: "o", kind: "orchestrator", label: "O" },
    { backend: "glm", brief: "dispatcher-2.md", id: "g", kind: "dispatcher", label: "G" },
  ]

  test("reads each backend as Claude Code, with glm as a GLM row's model", () => {
    expect(storedTemplates(old)).toEqual([
      {
        brief: "orchestrator.md",
        harness: "claude-code",
        id: "o",
        kind: "orchestrator",
        label: "O",
      },
      {
        brief: "dispatcher-2.md",
        harness: "claude-code",
        id: "g",
        kind: "dispatcher",
        label: "G",
        model: "glm",
      },
    ])
    expect(
      sessionSettings
        .get(
          settingsFor([{ key: "sessions.templates", scope: CORE, value: old }], "made-up-me"),
          "sessions.templates",
        )
        .map(templateBackend),
    ).toEqual(["claude", "glm"])
  })

  test("leaves a row in the new shape as it is, and one naming another backend for the schema to refuse", () => {
    const [assistant] = readSessionTemplates(mkdtempSync(join(scratch, "templates-")))
    expect(storedTemplates([assistant])).toEqual([assistant])
    const other = storedTemplates([{ ...old[0], backend: "gpt" }])
    expect(sessionTemplates.safeParse(other).success).toBe(false)
  })

  test("reads a Claude row that named glm as its model, which never ran, with the model dropped, beside the rest of the list", () => {
    const named = [{ ...old[0], id: "n", model: "glm" }, old[0]]
    expect(storedTemplates(named)).toEqual([
      {
        brief: "orchestrator.md",
        harness: "claude-code",
        id: "n",
        kind: "orchestrator",
        label: "O",
      },
      {
        brief: "orchestrator.md",
        harness: "claude-code",
        id: "o",
        kind: "orchestrator",
        label: "O",
      },
    ])
    expect(
      sessionSettings
        .get(
          settingsFor([{ key: "sessions.templates", scope: CORE, value: named }], "made-up-me"),
          "sessions.templates",
        )
        .map((t) => [t.id, templateBackend(t)]),
    ).toEqual([
      ["n", "claude"],
      ["o", "claude"],
    ])
  })
})

describe("saving sessions.templates", () => {
  const who = { actor: "dashboard", author: "owner", inboxRef: null, reason: "a made-up edit" }
  const machine = () => {
    const data = mkdtempSync(join(scratch, "save-"))
    mkdirSync(join(data, "extensions"), { recursive: true })
    writeFileSync(join(data, "extensions", "login"), "made-up-me\n")
    return data
  }
  const save = (data: string, value: unknown) =>
    setSetting(data, { key: "sessions.templates", scope: "made-up-me", value }, who)
  const orchestrator = () =>
    readSessionTemplates(mkdtempSync(join(scratch, "templates-"))).find(
      (t) => t.id === "orchestrator",
    )!

  test("an edit saves over the defaults, and the machine reads it", () => {
    const data = machine()
    const edited = { ...orchestrator(), effort: "high" as const, model: "opus" }
    expect(save(data, [edited])).toMatchObject({ ok: true })
    expect(readSetting(data, "sessions.templates")?.value).toEqual([edited])
  })

  test("a bad brief is refused at its field, in the words the editor places beside it", () => {
    expect(save(machine(), [{ ...orchestrator(), brief: "briefs/x.md" }])).toEqual({
      message: "sessions.templates: ✖ a brief is a file name, with no /   → at [0].brief",
      ok: false,
      status: 400,
    })
  })

  test("an account usage.accounts does not name is refused at its field, and one it names saves", () => {
    const data = machine()
    setSetting(
      data,
      {
        key: "usage.accounts",
        scope: "made-up-me",
        value: [{ email: "pat@example.com" }, { label: "zai", provider: "glm" }],
      },
      who,
    )
    expect(save(data, [{ ...orchestrator(), account: "sam@example.com" }])).toEqual({
      message:
        "sessions.templates: ✖ sam@example.com is not in usage.accounts: add it in Settings > Accounts   → at [0].account",
      ok: false,
      status: 400,
    })
    expect(readSetting(data, "sessions.templates")?.rows).toEqual([])
    expect(save(data, [{ ...orchestrator(), account: "pat@example.com" }])).toMatchObject({
      ok: true,
    })
  })
})
