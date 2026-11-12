import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  checklistOf,
  homeOf,
  noChat,
} from "../../../../../../web/next/src/components/dashboard/dashboard-view"

describe("homeOf", () => {
  test("a fresh Mac with no session yet, or none the feed can read, sees first run's steps, not the sessions line", () => {
    for (const live of ["Live", "Lost"] as const) {
      expect(homeOf({ boardRead: true, checksFailed: false, live, view: "steps" })).toBe("steps")
      expect(homeOf({ boardRead: true, checksFailed: false, live, view: "checks" })).toBe("checks")
    }
  })

  test("draws the neutral frame until the board and the checks are read", () => {
    expect(
      homeOf({ boardRead: false, checksFailed: false, live: "Connecting", view: "steps" }),
    ).toBe("frame")
    expect(homeOf({ boardRead: true, checksFailed: false, live: "Live", view: "frame" })).toBe(
      "frame",
    )
  })

  test("a failed checks read says so, and a reconnecting feed holds the steps but never the checks", () => {
    expect(homeOf({ boardRead: true, checksFailed: true, live: "Live", view: "frame" })).toBe(
      "error",
    )
    expect(
      homeOf({ boardRead: true, checksFailed: false, live: "Reconnecting", view: "steps" }),
    ).toBe("reconnecting")
    expect(
      homeOf({ boardRead: true, checksFailed: false, live: "Reconnecting", view: "checks" }),
    ).toBe("checks")
  })
})

// #1682: while a restore brings the factory back, the home says so with no Start, until the restore is done.
describe("homeOf while a restore runs", () => {
  test("shows the restore in place of the steps, for as long as the restore is owed", () => {
    for (const live of ["Live", "Lost"] as const) {
      expect(
        homeOf({ boardRead: true, checksFailed: false, live, restoring: true, view: "steps" }),
      ).toBe("restoring")
      expect(
        homeOf({ boardRead: true, checksFailed: false, live, restoring: false, view: "steps" }),
      ).toBe("steps")
    }
  })

  test("the frame, a failed read, the checks and a reconnecting feed still come first", () => {
    const at = { boardRead: true, checksFailed: false, live: "Live", restoring: true } as const
    expect(homeOf({ ...at, boardRead: false, view: "steps" })).toBe("frame")
    expect(homeOf({ ...at, checksFailed: true, view: "steps" })).toBe("error")
    expect(homeOf({ ...at, view: "checks" })).toBe("checks")
    expect(homeOf({ ...at, view: "frame" })).toBe("frame")
    expect(homeOf({ ...at, live: "Reconnecting", view: "steps" })).toBe("reconnecting")
  })
})

describe("noChat", () => {
  test("while a restore runs it says the factory is coming back, never that the dispatcher is not running", () => {
    const copy = noChat("Live", "Boss", true)
    expect(copy.title).toBe("The factory is coming back")
    expect(copy.why).toBe(
      "Your sessions are coming back after a restart. Boss's chat opens here once it is running.",
    )
    expect(`${copy.title} ${copy.why}`).not.toContain("not running")
  })

  test("with the feed reconnecting it says so in the sidebar's words, not that the dispatcher is not running", () => {
    const copy = noChat("Reconnecting", "Boss")
    expect(copy.title).toBe("Live feed reconnecting")
    expect(copy.title).not.toContain("not running")
    expect(copy.why).not.toContain("not running")
  })

  test("with the feed live it says the dispatcher is not running", () => {
    expect(noChat("Live", "Boss")).toEqual({
      title: "Boss is not running",
      why: "Boss's chat opens here once it is running.",
    })
  })
})

// The two dispatchers and every worker read by name, not by model.
describe("a chat's heading", () => {
  test("names the session as its row and composer do, a dispatcher by its label", async () => {
    const view = await Bun.file(
      new URL(
        "../../../../../../web/next/src/components/dashboard/dashboard-view.tsx",
        import.meta.url,
      ),
    ).text()
    expect(view).toContain('<h1 className="sr-only">{chatLabel(selected, dispatcher)}</h1>')
    expect(view).not.toContain("agentLabel(selected.name)")
  })

  // #780: the Assistant's view gets the composer, as a dispatcher's does
  test("a view draws the composer for every session that has a chat (hasChat), the assistant's included", async () => {
    const view = await Bun.file(
      new URL(
        "../../../../../../web/next/src/components/dashboard/dashboard-view.tsx",
        import.meta.url,
      ),
    ).text()
    expect(view).toMatch(
      /\{hasChat\(selected\) \? \(?\s*<Composer key=\{selected\.name\} worker=\{selected\} \/>/,
    )
  })
})

// The page needs the dashboard's context to render, so its loading state is read from the source.
test("the first load's spinner centres in the chat's own frame, so it never moves when the chat arrives (the owner: \"keep it at center of chat with input for initial loading too\")", async () => {
  const source = await Bun.file(
    join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/dashboard-view.tsx"),
  ).text()
  expect(source).toMatch(
    /<div className="relative mt-12 mb-26\.5 flex-1 sm:mb-24\.5 md:mb-23\.5">\s*<CenterSpinner \/>/,
  )
})

// The home's onboarding while no dispatcher runs: GitHub, Settings, the harness pick and, for Claude Code, the Claude account, each ticked once done, then Start; only the first undone row's button is active.
describe("checklistOf", () => {
  const done = (list: ReturnType<typeof checklistOf>) =>
    list.rows.filter((row) => row.done).map((row) => row.step)
  const pick = "claude-code" as const

  test.each([
    [{ claude: false, github: false, harness: false, login: false }, [], "github", false],
    [{ claude: false, github: true, harness: false, login: false }, ["github"], "settings", false],
    [
      { claude: false, github: true, harness: false, login: true },
      ["github", "settings"],
      "harness",
      false,
    ],
    [
      { claude: false, github: true, harness: true, login: true },
      ["github", "settings", "harness"],
      "account",
      false,
    ],
    [
      { claude: true, github: true, harness: true, login: true },
      ["github", "settings", "harness", "account"],
      "start",
      true,
    ],
    [
      { claude: true, github: false, harness: true, login: true },
      ["settings", "harness", "account"],
      "github",
      false,
    ],
    [
      { claude: true, github: true, harness: false, login: true },
      ["github", "settings", "account"],
      "harness",
      false,
    ],
    [
      { claude: true, github: true, harness: true, login: false },
      ["github", "harness", "account"],
      "settings",
      false,
    ],
  ] as const)("%o ticks %o, activates %s, shows Start: %s", (facts, ticked, active, start) => {
    const list = checklistOf({ ...facts, pick })
    expect(list.rows.map((row) => row.step)).toEqual(["github", "settings", "harness", "account"])
    expect(done(list)).toEqual([...ticked])
    expect(list.active).toBe(active)
    expect(list.start).toBe(start)
  })

  test("a Codex pick drops the Claude account row, so Start shows once its card is ready (#1835)", () => {
    const list = checklistOf({ github: true, harness: true, login: true, pick: "codex" })
    expect(list.rows.map((row) => row.step)).toEqual(["github", "settings", "harness"])
    expect(list).toMatchObject({ active: "start", known: true, start: true })
    expect(checklistOf({ github: true, harness: false, login: true, pick: "codex" }).active).toBe(
      "harness",
    )
  })

  test("until every fact is read, the pick included, it is not known: nothing ticked, no button live, no Start", () => {
    for (const facts of [
      {},
      { github: true },
      { github: true, login: false },
      { claude: true, github: true, harness: true, login: true },
      { claude: true, github: true, login: true, pick },
      { claude: false, harness: true, login: false, pick },
    ]) {
      const list = checklistOf(facts)
      expect(list).toMatchObject({ active: null, known: false, start: false })
      expect(done(list)).toEqual([])
    }
  })

  test("once every fact is read it is known", () => {
    expect(
      checklistOf({ claude: false, github: false, harness: false, login: false, pick }).known,
    ).toBe(true)
    expect(
      checklistOf({ claude: true, github: true, harness: true, login: true, pick }).known,
    ).toBe(true)
  })
})
